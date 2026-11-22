// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * AirPlay Engine: the picture for head units without GStreamer. The phone's H.264 is decoded here (FFmpeg's decoder,
 * linked statically), scaled to at most MAX_SIDE a side (the renderer's limit for a picture) as RGBA, and handed to
 * the app, which draws it through MGU Store's Renderer. Slower than a hardware decoder and a video layer, but it needs
 * nothing from the head unit.
 *
 * The app connects to <run>/frames.sock and asks for a picture by writing one byte ('r') whenever it can draw one;
 * the newest decoded picture is converted and sent then, and pictures decoded in between are skipped, so the phone is
 * never held up by the screen. Each picture: "APF1", width, height, byte count (u32, little endian), then RGBA rows.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>

#include "soft_video.h"

#define MAX_SIDE 1024

static struct {
	pthread_mutex_t lock;
	pthread_cond_t wake;
	int srv, client;
	int ready;               /* the app asked for a picture */
	int busy;                /* the writer is sending one */
	AVCodecContext *ctx;
	AVPacket *pkt;
	AVFrame *frame;
	struct SwsContext *sws;
	unsigned char *out;      /* header + RGBA, for the writer */
	size_t out_len, out_cap;
	int h265;
	unsigned long decoded, sent, failed;
	char path[300];
	int running;
	pthread_t accept_thread, write_thread;
} V = { PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, -1, -1 };

static void say(const char *fmt, const char *a)
{
	printf("[info] soft video: ");
	printf(fmt, a);
	printf("\n");
	fflush(stdout);
}

/* the app's connection: one at a time; its 'r' bytes ask for the next picture */
static void *accept_loop(void *arg)
{
	(void)arg;
	while(V.running)
	{
		struct pollfd p[2] = { { V.srv, POLLIN, 0 }, { V.client, POLLIN, 0 } };
		if(poll(p, V.client >= 0 ? 2 : 1, 250) <= 0) continue;
		if(p[0].revents & POLLIN)
		{
			int c = accept(V.srv, NULL, NULL);
			if(c < 0) continue;
			pthread_mutex_lock(&V.lock);
			if(V.client >= 0) close(V.client);
			V.client = c;
			V.ready = 0;
			pthread_mutex_unlock(&V.lock);
			say("the app is drawing the pictures%s", "");
			continue;
		}
		if(V.client >= 0 && (p[1].revents & (POLLIN | POLLHUP | POLLERR)))
		{
			char b[64];
			ssize_t n = read(V.client, b, sizeof(b));
			pthread_mutex_lock(&V.lock);
			if(n <= 0) { close(V.client); V.client = -1; V.ready = 0; }
			else if(memchr(b, 'r', (size_t)n)) V.ready = 1;
			pthread_mutex_unlock(&V.lock);
		}
	}
	return NULL;
}

/* sends the picture in V.out, outside the lock, then waits for the next */
static void *write_loop(void *arg)
{
	(void)arg;
	pthread_mutex_lock(&V.lock);
	while(V.running)
	{
		if(!V.busy) { pthread_cond_wait(&V.wake, &V.lock); continue; }
		int fd = V.client;
		unsigned char *b = V.out;
		size_t n = V.out_len, off = 0;
		pthread_mutex_unlock(&V.lock);
		while(fd >= 0 && off < n)
		{
			ssize_t w = write(fd, b + off, n - off);
			if(w < 0 && errno == EINTR) continue;
			if(w <= 0) break;
			off += (size_t)w;
		}
		pthread_mutex_lock(&V.lock);
		if(off == n) V.sent++; else V.failed++;
		V.busy = 0;
	}
	pthread_mutex_unlock(&V.lock);
	return NULL;
}

int sv_start(const char *run_dir)
{
	if(V.running) return 0;
	snprintf(V.path, sizeof(V.path), "%s/frames.sock", run_dir);
	unlink(V.path);
	V.srv = socket(AF_UNIX, SOCK_STREAM, 0);
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", V.path);
	if(V.srv < 0 || bind(V.srv, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(V.srv, 2) < 0)
	{
		say("cannot listen on %s", V.path);
		return -1;
	}
	chmod(V.path, 0666);
	V.running = 1;
	pthread_create(&V.accept_thread, NULL, accept_loop, NULL);
	pthread_create(&V.write_thread, NULL, write_loop, NULL);
	return 0;
}

static void decoder_close(void)
{
	if(V.ctx) avcodec_free_context(&V.ctx);
	if(V.pkt) av_packet_free(&V.pkt);
	if(V.frame) av_frame_free(&V.frame);
	if(V.sws) { sws_freeContext(V.sws); V.sws = NULL; }
}

static int decoder_open(int h265)
{
	const AVCodec *c = avcodec_find_decoder(h265 ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264);
	if(!c) { say("no %s decoder in this build", h265 ? "H.265" : "H.264"); return -1; }
	V.ctx = avcodec_alloc_context3(c);
	V.ctx->thread_count = 0;                          /* as many as the head unit has */
	V.ctx->thread_type = FF_THREAD_SLICE | FF_THREAD_FRAME;
	V.ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
	V.ctx->flags2 |= AV_CODEC_FLAG2_FAST;
	if(avcodec_open2(V.ctx, c, NULL) < 0) { decoder_close(); return -1; }
	V.pkt = av_packet_alloc();
	V.frame = av_frame_alloc();
	V.h265 = h265;
	return 0;
}

void sv_reset(void)
{
	pthread_mutex_lock(&V.lock);
	decoder_close();
	pthread_mutex_unlock(&V.lock);
}

/* the newest picture, as RGBA at most MAX_SIDE a side, ready for the writer. Called with the lock held. */
static void convert(const AVFrame *f)
{
	int w = f->width, h = f->height;
	if(w <= 0 || h <= 0) return;
	if(w > MAX_SIDE || h > MAX_SIDE)
	{
		if(w >= h) { h = (int)((int64_t)h * MAX_SIDE / w); w = MAX_SIDE; }
		else { w = (int)((int64_t)w * MAX_SIDE / h); h = MAX_SIDE; }
	}
	w &= ~1; h &= ~1;
	if(w < 2 || h < 2) return;
	V.sws = sws_getCachedContext(V.sws, f->width, f->height, (enum AVPixelFormat)f->format, w, h, AV_PIX_FMT_RGBA,
		SWS_FAST_BILINEAR, NULL, NULL, NULL);
	if(!V.sws) return;
	size_t need = 16 + (size_t)w * h * 4;
	if(need > V.out_cap)
	{
		unsigned char *n = realloc(V.out, need);
		if(!n) return;
		V.out = n; V.out_cap = need;
	}
	uint32_t head[4] = { 0x31465041 /* "APF1" */, (uint32_t)w, (uint32_t)h, (uint32_t)(need - 16) };
	memcpy(V.out, head, 16);
	uint8_t *dst[4] = { V.out + 16, NULL, NULL, NULL };
	int stride[4] = { w * 4, 0, 0, 0 };
	if(sws_scale(V.sws, (const uint8_t *const *)f->data, f->linesize, 0, f->height, dst, stride) <= 0) return;
	V.out_len = need;
	V.ready = 0;
	V.busy = 1;
	pthread_cond_signal(&V.wake);
}

void sv_feed(const unsigned char *data, int len, int h265)
{
	pthread_mutex_lock(&V.lock);
	if(V.ctx && V.h265 != h265) decoder_close();
	if(!V.ctx && decoder_open(h265)) { pthread_mutex_unlock(&V.lock); return; }
	V.pkt->data = (uint8_t *)data;
	V.pkt->size = len;
	int r = avcodec_send_packet(V.ctx, V.pkt);
	V.pkt->data = NULL; V.pkt->size = 0;
	if(r < 0 && r != AVERROR(EAGAIN)) { pthread_mutex_unlock(&V.lock); return; }
	while(avcodec_receive_frame(V.ctx, V.frame) == 0)
	{
		V.decoded++;
		/* only when the app wants one and the last one is out: the others are skipped (no conversion, no copy) */
		if(V.client >= 0 && V.ready && !V.busy) convert(V.frame);
		av_frame_unref(V.frame);
	}
	pthread_mutex_unlock(&V.lock);
}

void sv_stats(unsigned long *decoded, unsigned long *sent, int *app)
{
	pthread_mutex_lock(&V.lock);
	*decoded = V.decoded; *sent = V.sent; *app = V.client >= 0;
	pthread_mutex_unlock(&V.lock);
}
