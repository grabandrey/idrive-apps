// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * AirPlay Engine: the AirPlay screen-mirroring receiver for the AirPlay app (packages/airplay). A small program around
 * UxPlay's AirPlay library (https://github.com/FDH2/UxPlay, lib/: GPL-3.0 with its LGPL-2.1 parts, linked unmodified):
 *
 *   finding it    the car announces itself on the car's networks (mdns_ifaces.c: every private IPv4 interface, each
 *                 with its own address), as an AirPlay receiver named by the app ("iDrive"), only while the app asks
 *   pairing       the iPhone's AirPlay pairing and FairPlay setup: UxPlay's. With "pin" access (the default) a new phone
 *                 is asked once for a 4-digit PIN the car shows; it's remembered (clients.txt) after that
 *   the screen    the phone's mirrored screen (H.264, Annex B) goes to the video tool's stream socket
 *                 (/run/ida-remoteplay-video/stream.sock), which decodes it in hardware and shows it where, and in the
 *                 shape (fit, stretch, 16:9, 4:3, ...), the app asks
 *
 * Socket /run/ida-airplay-engine/engine.sock (0666: the app runs as its own user), JSON lines; the messages are in the
 * app's links.js. One client (the app) at a time.
 *
 *   -> {"op":"hello"}                                <- {"ok":true,"name","version"}
 *   -> {"op":"start","name":"iDrive","access":"pin"|"open","video":{"socket",..anything the video tool takes..}}
 *                                                       advertise and accept phones; the video object is the start
 *                                                       of the stream's header line
 *                                                       "video":{"mode":"soft"}: no video tool (no GStreamer on the head
 *                                                       unit): the picture is decoded here and handed to the app on
 *                                                       <run>/frames.sock (soft_video.c), and the phone asked for 720p30
 *   -> {"op":"view","video":{"aspect","rect",..}}     merged into the video object (for the next stream)
 *   -> {"op":"stop"}                                  stop advertising, drop the phone, end the video
 *   -> {"op":"status"}                                <- {"ok":true,"advertising","name","mirroring","width","height"}
 *   -> {"op":"forget"}                                forget the phones that paired with a PIN
 *   <- {"ev":"client","name","model","deviceId"}      a phone connecting
 *   <- {"ev":"pin","pin":"1234"}                      the PIN for the phone to type: show it now
 *   <- {"ev":"mirror","state":"started"|"paused"|"resumed"|"stopped","width","height","codec","reason"}
 *   <- {"ev":"conn","open":1}                         how many connections are open
 *   <- {"ev":"net","how":"wlan0 192.168.1.1 fe80::1, ..."}  where the phone can find it (mdns_ifaces.c)
 *
 * Sound: not played (the car's audio is BMW's); the phone's sound goes nowhere while it mirrors.
 * Built by build.sh: static, musl, for x86_64 and aarch64.
 */
#define _GNU_SOURCE
#include "raop.h"
#include "dnssd.h"
#include "logger.h"
#include "soft_video.h"
#include <plist/plist.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define ENGINE_VERSION "1.2.0"
#define DEFAULT_RUN "/run/ida-airplay-engine"
#define DEFAULT_DATA "/var/opt/ida-airplay-engine"
#define MAX_LINE 65536
#define SPS_PPS_MAX 1024

static char run_dir[256], data_dir[256], sock_path[300], key_path[300], clients_path[300], id_path[300];
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t st_lock = PTHREAD_MUTEX_INITIALIZER;
static int client = -1;

/* ---- the log: stdout, which the service sends to the journal ---- */
static void say(const char *level, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	printf("[%s] ", level);
	vprintf(fmt, ap);
	printf("\n");
	fflush(stdout);
	va_end(ap);
}

static void lib_log(void *cls, int level, const char *msg)
{
	(void)cls;
	if(level > LOGGER_INFO) return;
	say(level <= LOGGER_ERR ? "error" : level == LOGGER_WARNING ? "warn" : "info", "uxplay: %s", msg);
}

/* ---- JSON, through libplist ---- */
static void send_plist(plist_t o)
{
	char *s = NULL;
	uint32_t len = 0;
	if(plist_to_json(o, &s, &len, 0) != PLIST_ERR_SUCCESS || !s) return;
	for(uint32_t i = 0; i < len; i++) if(s[i] == '\n') s[i] = ' ';
	pthread_mutex_lock(&out_lock);
	if(client >= 0 && (write(client, s, len) != (ssize_t)len || write(client, "\n", 1) != 1))
		say("warn", "app: write failed: %s", strerror(errno));
	pthread_mutex_unlock(&out_lock);
	plist_mem_free(s);
}

static plist_t ev_new(const char *ev)
{
	plist_t o = plist_new_dict();
	plist_dict_set_item(o, "ev", plist_new_string(ev));
	return o;
}
static void set_str(plist_t o, const char *k, const char *v) { if(v) plist_dict_set_item(o, k, plist_new_string(v)); }
static void set_int(plist_t o, const char *k, int64_t v) { plist_dict_set_item(o, k, plist_new_int(v)); }
static void set_bool(plist_t o, const char *k, int v) { plist_dict_set_item(o, k, plist_new_bool(v ? 1 : 0)); }
static void emit(plist_t o) { send_plist(o); plist_free(o); }

static void reply(plist_t id, plist_t extra, const char *error)
{
	plist_t o = extra ? extra : plist_new_dict();
	if(id) plist_dict_set_item(o, "id", plist_copy(id));
	set_bool(o, "ok", !error);
	if(error) set_str(o, "error", error);
	emit(o);
}

static const char *str_of(plist_t o, const char *k)
{
	plist_t n = o ? plist_dict_get_item(o, k) : NULL;
	return n && plist_get_node_type(n) == PLIST_STRING ? plist_get_string_ptr(n, NULL) : NULL;
}

/* ---- state ---- */
static struct {
	raop_t *raop;
	dnssd_t *dnssd;
	unsigned short port;
	char name[128];
	int pin;                 /* "pin" access: a PIN the first time a phone connects */
	int soft;                /* decoded here, drawn by the app (no GStreamer) */
	plist_t video;           /* the app's video object: the start of the stream's header */
	int open;                /* connections */
	/* the mirrored screen */
	int codec;               /* 0 none, 1 H.264, 2 H.265 */
	int width, height;
	int vfd;                 /* the video tool's stream socket */
	int mirroring;
	unsigned char sps_pps[SPS_PPS_MAX];
	size_t sps_pps_len;
	volatile int reset_httpd;
} S = { .vfd = -1 };

/* where the phone can find the car, from mdns_ifaces.c */
extern void (*ida_mdns_report)(const char *how);
static char net_how[1024];
static void on_mdns(const char *how)
{
	snprintf(net_how, sizeof(net_how), "%s", how);
	plist_t o = ev_new("net");
	set_str(o, "how", how);
	emit(o);
}

static char hw_addr[6];
static char device_id[18];

/* this car's AirPlay identity: a random, locally administered MAC, made once and kept */
static void load_identity(void)
{
	FILE *f = fopen(id_path, "r");
	unsigned v[6];
	if(f && fscanf(f, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) == 6)
	{
		for(int i = 0; i < 6; i++) hw_addr[i] = (char)v[i];
	}
	else
	{
		int r = open("/dev/urandom", O_RDONLY);
		if(r < 0 || read(r, hw_addr, 6) != 6) { srand((unsigned)time(NULL) ^ (unsigned)getpid()); for(int i = 0; i < 6; i++) hw_addr[i] = (char)rand(); }
		if(r >= 0) close(r);
		hw_addr[0] = (char)((hw_addr[0] & 0xfe) | 0x02);
		FILE *w = fopen(id_path, "w");
		if(w)
		{
			fprintf(w, "%02x:%02x:%02x:%02x:%02x:%02x\n", (unsigned char)hw_addr[0], (unsigned char)hw_addr[1], (unsigned char)hw_addr[2],
				(unsigned char)hw_addr[3], (unsigned char)hw_addr[4], (unsigned char)hw_addr[5]);
			fclose(w);
		}
	}
	if(f) fclose(f);
	snprintf(device_id, sizeof(device_id), "%02x:%02x:%02x:%02x:%02x:%02x", (unsigned char)hw_addr[0], (unsigned char)hw_addr[1],
		(unsigned char)hw_addr[2], (unsigned char)hw_addr[3], (unsigned char)hw_addr[4], (unsigned char)hw_addr[5]);
}

/* ---- the video tool's stream socket ---- */
static int write_all(int fd, const unsigned char *b, size_t n)
{
	while(n)
	{
		ssize_t w = write(fd, b, n);
		if(w < 0) { if(errno == EINTR) continue; return -1; }
		b += w; n -= (size_t)w;
	}
	return 0;
}

static void video_close(const char *why)
{
	if(S.vfd < 0) return;
	close(S.vfd);
	S.vfd = -1;
	say("info", "video: stream closed (%s)", why);
}

/* the header line: the app's video object with what the phone sends filled in */
static int video_open(void)
{
	const char *path = str_of(S.video, "socket");
	if(!path) path = "/run/ida-remoteplay-video/stream.sock";
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", path);
	if(fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof(a)) < 0)
	{
		say("warn", "video: cannot open %s: %s", path, strerror(errno));
		if(fd >= 0) close(fd);
		return -1;
	}
	struct timeval tv = { 2, 0 };
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
	plist_t h = S.video ? plist_copy(S.video) : plist_new_dict();
	plist_dict_remove_item(h, "socket");
	set_str(h, "codec", S.codec == 2 ? "h265" : "h264");
	if(S.width) set_int(h, "width", S.width);
	if(S.height) set_int(h, "height", S.height);
	if(!plist_dict_get_item(h, "fps")) set_int(h, "fps", 60);
	set_str(h, "source", "airplay");
	char *s = NULL;
	uint32_t len = 0;
	plist_to_json(h, &s, &len, 0);
	plist_free(h);
	for(uint32_t i = 0; s && i < len; i++) if(s[i] == '\n') s[i] = ' ';
	int bad = !s || write_all(fd, (unsigned char *)s, len) || write_all(fd, (const unsigned char *)"\n", 1);
	say("info", "video: stream to %s: %s", path, s ? s : "");
	if(s) plist_mem_free(s);
	if(bad) { close(fd); return -1; }
	return fd;
}

/* the SPS/PPS at the front of a buffer (the library puts them before the frame after each codec packet): kept, so a
 * stream reopened mid-way starts with them */
static void keep_sps_pps(const unsigned char *d, size_t n)
{
	if(n < 5 || d[0] || d[1] || d[2] != 0 || d[3] != 1) return;
	int h265 = S.codec == 2;
	int t = h265 ? (d[4] >> 1) & 63 : d[4] & 31;
	if(h265 ? t != 32 : t != 7) return;
	size_t end = 4;
	for(;;)
	{
		size_t i = end;
		while(i + 4 <= n && !(d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 0 && d[i + 3] == 1)) i++;
		if(i + 4 > n) return;
		int nt = h265 ? (d[i + 4] >> 1) & 63 : d[i + 4] & 31;
		int param = h265 ? (nt >= 32 && nt <= 34) : (nt == 7 || nt == 8);
		if(!param) { end = i; break; }
		end = i + 4;
	}
	if(end <= SPS_PPS_MAX) { memcpy(S.sps_pps, d, end); S.sps_pps_len = end; }
}

/* ---- the library's callbacks (its threads) ---- */
static void cb_video_process(void *cls, raop_ntp_t *ntp, video_decode_struct *v)
{
	(void)cls; (void)ntp;
	if(!v || !v->data || v->data_len <= 0) return;
	pthread_mutex_lock(&st_lock);
	if(!S.codec) S.codec = v->is_h265 ? 2 : 1;
	if(S.soft)
	{
		int h265 = S.codec == 2;
		pthread_mutex_unlock(&st_lock);
		sv_feed(v->data, v->data_len, h265);
		return;
	}
	keep_sps_pps(v->data, (size_t)v->data_len);
	int fresh = 0;
	if(S.vfd < 0 && S.video)
	{
		S.vfd = video_open();
		fresh = S.vfd >= 0;
	}
	if(S.vfd >= 0)
	{
		int starts_with_params = v->data_len >= 5 && (S.codec == 2 ? ((v->data[4] >> 1) & 63) == 32 : (v->data[4] & 31) == 7);
		if(fresh && !starts_with_params && S.sps_pps_len && write_all(S.vfd, S.sps_pps, S.sps_pps_len)) video_close("write failed");
		if(S.vfd >= 0 && write_all(S.vfd, v->data, (size_t)v->data_len)) video_close(errno == EAGAIN ? "the video tool is not reading" : strerror(errno));
	}
	pthread_mutex_unlock(&st_lock);
}

static int cb_codec_and_size(void *cls, video_codec_t codec, unsigned short ws, unsigned short hs, unsigned short x, unsigned short y,
	unsigned short w, unsigned short h)
{
	(void)cls; (void)x; (void)y; (void)w; (void)h;
	pthread_mutex_lock(&st_lock);
	S.codec = codec == VIDEO_CODEC_H265 ? 2 : 1;
	S.width = ws; S.height = hs;
	S.mirroring = 1;
	S.sps_pps_len = 0;
	video_close("a new stream");
	pthread_mutex_unlock(&st_lock);
	if(S.soft) sv_reset();
	say("info", "mirror: %s %ux%u", codec == VIDEO_CODEC_H265 ? "H.265" : "H.264", ws, hs);
	plist_t o = ev_new("mirror");
	set_str(o, "state", "started");
	set_str(o, "codec", codec == VIDEO_CODEC_H265 ? "h265" : "h264");
	set_int(o, "width", ws); set_int(o, "height", hs);
	emit(o);
	return 0;
}

static void mirror_stopped(const char *why)
{
	pthread_mutex_lock(&st_lock);
	int was = S.mirroring;
	S.mirroring = 0;
	S.codec = 0;
	S.width = S.height = 0;
	S.sps_pps_len = 0;
	video_close(why);
	pthread_mutex_unlock(&st_lock);
	if(!was) return;
	plist_t o = ev_new("mirror");
	set_str(o, "state", "stopped");
	set_str(o, "reason", why);
	emit(o);
}

static void cb_video_reset(void *cls, reset_type_t t)
{
	(void)cls;
	mirror_stopped(t == RESET_TYPE_NOHOLD ? "another phone took over" : "the phone stopped mirroring");
}

static void cb_pause(void *cls) { (void)cls; plist_t o = ev_new("mirror"); set_str(o, "state", "paused"); emit(o); }
static void cb_resume(void *cls) { (void)cls; plist_t o = ev_new("mirror"); set_str(o, "state", "resumed"); emit(o); }

static void conns(int d)
{
	pthread_mutex_lock(&st_lock);
	S.open += d;
	if(S.open < 0) S.open = 0;
	int n = S.open;
	pthread_mutex_unlock(&st_lock);
	plist_t o = ev_new("conn");
	set_int(o, "open", n);
	emit(o);
	if(!n) mirror_stopped("the phone disconnected");
}
static void cb_conn_init(void *cls) { (void)cls; conns(1); }
static void cb_conn_destroy(void *cls) { (void)cls; conns(-1); }
static void cb_conn_reset(void *cls, int reason)
{
	(void)cls;
	say("warn", "connection lost%s", reason == 1 ? " (network problem?)" : "");
	S.reset_httpd = 1;
	mirror_stopped(reason == 1 ? "the connection was lost" : "the phone's stream isn't supported");
}

static void cb_client(void *cls, char *dev, char *model, char *name, bool *admit)
{
	(void)cls;
	*admit = true;
	say("info", "phone: %s (%s, %s)", name ? name : "?", model ? model : "?", dev ? dev : "?");
	plist_t o = ev_new("client");
	set_str(o, "name", name); set_str(o, "model", model); set_str(o, "deviceId", dev);
	emit(o);
}

static void cb_pin(void *cls, char *pin)
{
	(void)cls;
	say("info", "PIN for the phone: %s", pin);
	plist_t o = ev_new("pin");
	set_str(o, "pin", pin);
	emit(o);
}

/* phones that typed the PIN once: their pairing keys, one a line (key,time,deviceid,name) */
static void cb_register(void *cls, const char *dev, const char *pk, const char *name)
{
	(void)cls;
	FILE *f = fopen(clients_path, "a");
	if(!f) { say("warn", "cannot keep the phone's pairing: %s", strerror(errno)); return; }
	fchmod(fileno(f), 0600);
	fprintf(f, "%s,%ld,%s,%s\n", pk, (long)time(NULL), dev ? dev : "", name ? name : "");
	fclose(f);
	say("info", "paired: %s", name ? name : dev);
}

static bool cb_check(void *cls, const char *pk)
{
	(void)cls;
	if(!S.pin) return true;
	FILE *f = fopen(clients_path, "r");
	char line[1024];
	size_t n = strlen(pk);
	bool ok = false;
	while(f && fgets(line, sizeof(line), f)) if(!strncmp(line, pk, n) && line[n] == ',') { ok = true; break; }
	if(f) fclose(f);
	if(!ok) say("info", "a phone paired before but not known here: it will be asked for a PIN");
	return ok;
}

static void cb_audio(void *cls, raop_ntp_t *ntp, audio_decode_struct *d) { (void)cls; (void)ntp; (void)d; }
static void cb_noop(void *cls) { (void)cls; }
static double cb_volume(void *cls) { (void)cls; return 0.0; }
static void cb_set_volume(void *cls, float v) { (void)cls; (void)v; }
static void cb_format(void *cls, unsigned char *ct, unsigned short *spf, bool *screen, bool *media, uint64_t *fmt)
{
	(void)cls; (void)ct; (void)spf; (void)screen; (void)media; (void)fmt;
}
static void cb_meta(void *cls, const void *b, int n) { (void)cls; (void)b; (void)n; }

/* ---- the receiver ---- */
static void features(dnssd_t *d, int pin)
{
	/* as UxPlay sets them: screen mirroring and audio; no HLS video, no H.265 (the decoders are checked for H.264) */
	static const int on[] = { 1, 2, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 28, 30 };
	for(int b = 0; b < 62; b++) dnssd_set_airplay_features(d, b, 0);
	for(size_t i = 0; i < sizeof(on) / sizeof(on[0]); i++) dnssd_set_airplay_features(d, on[i], 1);
	dnssd_set_airplay_features(d, 27, pin);    /* legacy pairing: the PIN */
}

static void receiver_stop(void)
{
	net_how[0] = 0;
	if(S.dnssd) { dnssd_unregister_raop(S.dnssd); dnssd_unregister_airplay(S.dnssd); dnssd_destroy(S.dnssd); S.dnssd = NULL; }
	if(S.raop) { raop_destroy(S.raop); S.raop = NULL; }
	mirror_stopped("the receiver stopped");
	S.open = 0;
}

static const char *receiver_start(void)
{
	raop_callbacks_t cb;
	memset(&cb, 0, sizeof(cb));
	cb.video_process = cb_video_process;
	cb.video_set_codec_and_size = cb_codec_and_size;
	cb.video_reset = cb_video_reset;
	cb.video_pause = cb_pause;
	cb.video_resume = cb_resume;
	cb.video_flush = cb_noop;
	cb.audio_process = cb_audio;
	cb.audio_flush = cb_noop;
	cb.audio_set_client_volume = cb_volume;
	cb.audio_set_volume = cb_set_volume;
	cb.audio_get_format = cb_format;
	cb.audio_set_metadata = cb_meta;
	cb.audio_set_coverart = cb_meta;
	cb.audio_stop_coverart_rendering = cb_noop;
	cb.conn_init = cb_conn_init;
	cb.conn_destroy = cb_conn_destroy;
	cb.conn_reset = cb_conn_reset;
	cb.conn_feedback = cb_noop;
	cb.report_client_request = cb_client;
	cb.display_pin = cb_pin;
	cb.register_client = cb_register;
	cb.check_register = cb_check;

	S.raop = raop_init(&cb);
	if(!S.raop) return "the AirPlay library did not start";
	raop_set_log_callback(S.raop, lib_log, NULL);
	raop_set_log_level(S.raop, LOGGER_INFO);
	if(raop_init2(S.raop, 1, device_id, key_path)) { free(S.raop); S.raop = NULL; return "the AirPlay library did not start (its key)"; }
	/* what the phone is told about the screen: 1920x1080 at up to 60 fps (it keeps its own shape inside that) */
	/* decoded here (soft): 720p at 30 fps, which a head unit's processor can decode */
	raop_set_plist(S.raop, "width", S.soft ? 1280 : 1920);
	raop_set_plist(S.raop, "height", S.soft ? 720 : 1080);
	raop_set_plist(S.raop, "refreshRate", 60);
	raop_set_plist(S.raop, "maxFPS", S.soft ? 30 : 60);
	if(S.pin) raop_set_plist(S.raop, "pin", 0);
	unsigned short tcp[3] = { 0, 0, 0 }, udp[3] = { 0, 0, 0 };
	raop_set_tcp_ports(S.raop, tcp);
	raop_set_udp_ports(S.raop, udp);
	S.port = raop_get_port(S.raop);
	if(raop_start_httpd(S.raop, &S.port) < 0) { receiver_stop(); return "cannot listen for phones"; }
	raop_set_port(S.raop, S.port);

	int err = 0;
	S.dnssd = dnssd_init(S.name, (int)strlen(S.name), hw_addr, 6, (unsigned char)(S.pin ? 1 : 0), &err);
	if(err || !S.dnssd) { receiver_stop(); return "cannot set up the announcement"; }
	features(S.dnssd, S.pin);
	raop_set_dnssd(S.raop, S.dnssd);
	if(dnssd_register_raop(S.dnssd, S.port) || dnssd_register_airplay(S.dnssd, S.port))
	{
		receiver_stop();
		return "cannot announce the receiver (UDP 5353 in use, or no multicast)";
	}
	say("info", "receiver \"%s\" on port %u (%s access, %s), id %s", S.name, S.port, S.pin ? "PIN" : "open",
		S.soft ? "decoded here, drawn by the app" : "to the video tool", device_id);
	return NULL;
}

/* ---- the app's requests ---- */
static void merge(plist_t into, plist_t from)
{
	plist_dict_iter it = NULL;
	plist_dict_new_iter(from, &it);
	for(;;)
	{
		char *k = NULL;
		plist_t v = NULL;
		plist_dict_next_item(from, it, &k, &v);
		if(!k) break;
		plist_dict_set_item(into, k, plist_copy(v));
		plist_mem_free(k);
	}
	free(it);
}

static void handle(plist_t m)
{
	plist_t id = plist_dict_get_item(m, "id");
	const char *op = str_of(m, "op");
	if(!op) { reply(id, NULL, "no op"); return; }
	if(!strcmp(op, "hello"))
	{
		plist_t o = plist_new_dict();
		set_str(o, "name", "AirPlay Engine");
		set_str(o, "version", ENGINE_VERSION);
		set_str(o, "deviceId", device_id);
		set_bool(o, "soft", 1);
		reply(id, o, NULL);
	}
	else if(!strcmp(op, "start"))
	{
		const char *name = str_of(m, "name");
		const char *access = str_of(m, "access");
		int pin = !access || strcmp(access, "open");
		char want[128];
		snprintf(want, sizeof(want), "%s", name && *name ? name : "iDrive");
		for(char *c = want; *c; c++) if(*c == '.' || *c == '@') *c = ' ';
		plist_t video = plist_dict_get_item(m, "video");
		const char *mode = video ? str_of(video, "mode") : NULL;
		int soft = mode && !strcmp(mode, "soft");
		pthread_mutex_lock(&st_lock);
		if(S.video) plist_free(S.video);
		S.video = video && plist_get_node_type(video) == PLIST_DICT ? plist_copy(video) : plist_new_dict();
		pthread_mutex_unlock(&st_lock);
		const char *err = NULL;
		if(S.raop && (strcmp(want, S.name) || pin != S.pin || soft != S.soft)) receiver_stop();
		if(!S.raop)
		{
			snprintf(S.name, sizeof(S.name), "%s", want);
			S.pin = pin;
			S.soft = soft;
			err = receiver_start();
		}
		plist_t o = plist_new_dict();
		set_str(o, "name", S.name);
		set_int(o, "port", S.port);
		reply(id, err ? (plist_free(o), NULL) : o, err);
	}
	else if(!strcmp(op, "view"))
	{
		plist_t video = plist_dict_get_item(m, "video");
		pthread_mutex_lock(&st_lock);
		if(!S.video) S.video = plist_new_dict();
		if(video && plist_get_node_type(video) == PLIST_DICT) merge(S.video, video);
		pthread_mutex_unlock(&st_lock);
		reply(id, NULL, NULL);
	}
	else if(!strcmp(op, "stop"))
	{
		if(S.raop) say("info", "receiver stopped (asked)");
		receiver_stop();
		reply(id, NULL, NULL);
	}
	else if(!strcmp(op, "status"))
	{
		plist_t o = plist_new_dict();
		set_bool(o, "advertising", S.raop != NULL);
		set_str(o, "network", net_how);
		set_str(o, "name", S.name);
		pthread_mutex_lock(&st_lock);
		set_bool(o, "mirroring", S.mirroring);
		set_int(o, "width", S.width); set_int(o, "height", S.height); set_int(o, "open", S.open);
		set_bool(o, "soft", S.soft);
		pthread_mutex_unlock(&st_lock);
		unsigned long dec = 0, sent = 0;
		int app = 0;
		sv_stats(&dec, &sent, &app);
		set_int(o, "decoded", (int64_t)dec); set_int(o, "drawn", (int64_t)sent); set_bool(o, "drawing", app);
		reply(id, o, NULL);
	}
	else if(!strcmp(op, "forget"))
	{
		unlink(clients_path);
		say("info", "paired phones forgotten");
		reply(id, NULL, NULL);
	}
	else reply(id, NULL, "unknown op");
}

static volatile sig_atomic_t quit;
static void on_signal(int s) { (void)s; quit = 1; }

int main(int argc, char **argv)
{
	snprintf(run_dir, sizeof(run_dir), "%s", argc > 1 ? argv[1] : DEFAULT_RUN);
	snprintf(data_dir, sizeof(data_dir), "%s", argc > 2 ? argv[2] : DEFAULT_DATA);
	snprintf(sock_path, sizeof(sock_path), "%s/engine.sock", run_dir);
	snprintf(key_path, sizeof(key_path), "%s/airplay.pem", data_dir);
	snprintf(clients_path, sizeof(clients_path), "%s/clients.txt", data_dir);
	snprintf(id_path, sizeof(id_path), "%s/id", data_dir);
	mkdir(run_dir, 0755);
	mkdir(data_dir, 0700);
	signal(SIGPIPE, SIG_IGN);
	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	say("info", "AirPlay Engine %s starting", ENGINE_VERSION);
	ntp_global_init();
	ida_mdns_report = on_mdns;
	sv_start(run_dir);
	load_identity();

	int srv = socket(AF_UNIX, SOCK_STREAM, 0);
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", sock_path);
	unlink(sock_path);
	if(srv < 0 || bind(srv, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(srv, 2) < 0)
	{
		say("error", "cannot listen on %s: %s", sock_path, strerror(errno));
		return 1;
	}
	chmod(sock_path, 0666);
	say("info", "listening on %s", sock_path);

	static char buf[MAX_LINE];
	size_t have = 0;
	while(!quit)
	{
		struct pollfd p[2] = { { srv, POLLIN, 0 }, { client, POLLIN, 0 } };
		int r = poll(p, client >= 0 ? 2 : 1, 250);
		if(S.reset_httpd && S.raop)
		{
			/* the library asks for a fresh start after a lost connection */
			S.reset_httpd = 0;
			say("info", "restarting the receiver after a lost connection");
			receiver_stop();
			const char *err = receiver_start();
			if(err) say("error", "%s", err);
		}
		if(r <= 0) continue;
		if(p[0].revents & POLLIN)
		{
			int c = accept(srv, NULL, NULL);
			if(c >= 0)
			{
				pthread_mutex_lock(&out_lock);
				if(client >= 0) close(client);
				client = c;
				pthread_mutex_unlock(&out_lock);
				have = 0;
				say("info", "app connected");
			}
			continue;
		}
		if(client >= 0 && (p[1].revents & (POLLIN | POLLHUP | POLLERR)))
		{
			ssize_t n = read(client, buf + have, sizeof(buf) - 1 - have);
			if(n <= 0)
			{
				pthread_mutex_lock(&out_lock);
				close(client);
				client = -1;
				pthread_mutex_unlock(&out_lock);
				say("info", "app gone: the receiver stops");
				receiver_stop();
				continue;
			}
			have += (size_t)n;
			char *start = buf, *nl;
			while((nl = memchr(start, '\n', have - (size_t)(start - buf))))
			{
				*nl = 0;
				plist_t m = NULL;
				if(nl > start && plist_from_json(start, (uint32_t)(nl - start), &m) == PLIST_ERR_SUCCESS && m && plist_get_node_type(m) == PLIST_DICT)
					handle(m);
				else if(nl > start) say("warn", "app: not JSON");
				if(m) plist_free(m);
				start = nl + 1;
			}
			have -= (size_t)(start - buf);
			memmove(buf, start, have);
			if(have >= sizeof(buf) - 1) have = 0;
		}
	}
	say("info", "stopping");
	receiver_stop();
	unlink(sock_path);
	return 0;
}
