// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Remote Play Engine: the stream engine for the Remote Play app (packages/remoteplay). A small program around
 * chiaki-ng's Remote Play library (https://github.com/streetpea/chiaki-ng, AGPL-3.0, linked unmodified):
 *
 *   pairing        chiaki_regist with the console's PIN and the account id
 *   the session    chiaki_session: the console's encrypted stream; its video frames (H.264 / H.265, Annex B) go to the
 *                  video tool's stream socket, which decodes them in hardware at the stream's rate
 *   the controller each {"op":"input"} from the app becomes the session's controller state
 *
 * Socket /run/ida-remoteplay-engine/engine.sock (0666: the app runs as its own user), JSON lines; the messages are in
 * the app's links.js. One client (the app) at a time; one pairing or one session at a time.
 *
 * Audio is not sent anywhere yet (the car's audio is BMW's): the session runs with audio off.
 * Built by build.sh: static, musl, for x86_64 and aarch64.
 */
#define _GNU_SOURCE
#include <chiaki/common.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>
#include <chiaki/controller.h>
#include <chiaki/base64.h>
#include <json-c/json_object.h>
#include <json-c/json_tokener.h>

#include <errno.h>
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

#define ENGINE_VERSION "1.0.0"
#define DEFAULT_RUN "/run/ida-remoteplay-engine"

static char sock_path[256];
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static int client = -1;            /* the app's connection */
static ChiakiLog clog;

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

static void chiaki_log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	say(level == CHIAKI_LOG_ERROR ? "error" : level == CHIAKI_LOG_WARNING ? "warn" : level == CHIAKI_LOG_INFO ? "info" : "debug", "chiaki: %s", msg);
}

/* ---- to the app: one JSON object a line ---- */
static void send_json(json_object *o)
{
	const char *s = json_object_to_json_string_ext(o, JSON_C_TO_STRING_PLAIN);
	pthread_mutex_lock(&out_lock);
	if(client >= 0)
	{
		size_t len = strlen(s);
		if(write(client, s, len) != (ssize_t)len || write(client, "\n", 1) != 1)
			say("warn", "app: write failed: %s", strerror(errno));
	}
	pthread_mutex_unlock(&out_lock);
	json_object_put(o);
}

static void reply_ok(int id, json_object *extra)
{
	json_object *o = extra ? extra : json_object_new_object();
	json_object_object_add(o, "id", json_object_new_int(id));
	json_object_object_add(o, "ok", json_object_new_boolean(1));
	send_json(o);
}

static void reply_err(int id, const char *fmt, ...)
{
	char buf[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	json_object *o = json_object_new_object();
	json_object_object_add(o, "id", json_object_new_int(id));
	json_object_object_add(o, "ok", json_object_new_boolean(0));
	json_object_object_add(o, "error", json_object_new_string(buf));
	send_json(o);
	say("warn", "refused: %s", buf);
}

static void session_event(const char *state, const char *reason)
{
	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string("session"));
	json_object_object_add(o, "state", json_object_new_string(state));
	if(reason)
		json_object_object_add(o, "reason", json_object_new_string(reason));
	send_json(o);
}

/* ---- small helpers ---- */
static const char *str_of(json_object *o, const char *key)
{
	json_object *v;
	return json_object_object_get_ex(o, key, &v) && json_object_is_type(v, json_type_string) ? json_object_get_string(v) : NULL;
}

static int int_of(json_object *o, const char *key, int def)
{
	json_object *v;
	return json_object_object_get_ex(o, key, &v) ? json_object_get_int(v) : def;
}

static json_object *obj_of(json_object *o, const char *key)
{
	json_object *v;
	return json_object_object_get_ex(o, key, &v) && json_object_is_type(v, json_type_object) ? v : NULL;
}

static int b64_decode_exact(const char *in, uint8_t *out, size_t want)
{
	if(!in)
		return -1;
	size_t size = want + 4;
	uint8_t buf[64];
	if(size > sizeof(buf))
		return -1;
	size = sizeof(buf);
	if(chiaki_base64_decode(in, strlen(in), buf, &size) != CHIAKI_ERR_SUCCESS || size != want)
		return -1;
	memcpy(out, buf, want);
	return 0;
}

static json_object *b64_string(const uint8_t *data, size_t size)
{
	char buf[64];
	if(chiaki_base64_encode(data, size, buf, sizeof(buf)) != CHIAKI_ERR_SUCCESS)
		return json_object_new_string("");
	return json_object_new_string(buf);
}

static int is_ps4(json_object *m)
{
	const char *type = str_of(m, "type");
	return type && !strcmp(type, "PS4");
}

/* ======================================================================== pairing */
static struct {
	int busy;
	int id;
	ChiakiRegist regist;
	char host[128];
	int ps5;
} reg;

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	(void)user;
	int id = reg.id;
	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ChiakiRegisteredHost *h = event->registered_host;
		/* the regist key: the console's hex text, kept as text (the wake credential is it read as hex) */
		char key[CHIAKI_SESSION_AUTH_SIZE + 1];
		memcpy(key, h->rp_regist_key, CHIAKI_SESSION_AUTH_SIZE);
		key[CHIAKI_SESSION_AUTH_SIZE] = 0;
		char mac[18];
		snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x", h->server_mac[0], h->server_mac[1], h->server_mac[2],
			h->server_mac[3], h->server_mac[4], h->server_mac[5]);
		json_object *r = json_object_new_object();
		json_object_object_add(r, "registKey", json_object_new_string(key));
		json_object_object_add(r, "rpRegistKey", b64_string((const uint8_t *)h->rp_regist_key, CHIAKI_SESSION_AUTH_SIZE));
		json_object_object_add(r, "rpKey", b64_string(h->rp_key, sizeof(h->rp_key)));
		json_object_object_add(r, "rpKeyType", json_object_new_int((int)h->rp_key_type));
		json_object_object_add(r, "target", json_object_new_int((int)h->target));
		json_object_object_add(r, "nickname", json_object_new_string(h->server_nickname));
		json_object_object_add(r, "mac", json_object_new_string(mac));
		json_object *o = json_object_new_object();
		json_object_object_add(o, "registered", r);
		say("info", "paired with %s (%s)", h->server_nickname, reg.host);
		reply_ok(id, o);
	}
	else if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED)
		reply_err(id, "pairing cancelled");
	else
		reply_err(id, "the console refused the pairing (wrong or expired PIN, another account, or Remote Play off)");
	reg.busy = 2;     /* finished: the main loop cleans up */
}

static void do_register(int id, json_object *m)
{
	if(reg.busy)
	{
		reply_err(id, "already pairing");
		return;
	}
	const char *host = str_of(m, "host"), *account = str_of(m, "accountId"), *pin = str_of(m, "pin");
	if(!host || !account || !pin || strlen(pin) != 8)
	{
		reply_err(id, "register needs host, accountId and an 8-digit pin");
		return;
	}
	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	if(b64_decode_exact(account, info.psn_account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE) < 0)
	{
		reply_err(id, "the account id isn't 8 bytes of base64");
		return;
	}
	snprintf(reg.host, sizeof(reg.host), "%s", host);
	reg.ps5 = !is_ps4(m);
	info.target = reg.ps5 ? CHIAKI_TARGET_PS5_1 : CHIAKI_TARGET_PS4_10;
	info.host = reg.host;
	info.broadcast = false;
	info.psn_online_id = NULL;
	info.pin = (uint32_t)strtoul(pin, NULL, 10);
	info.console_pin = 0;
	info.holepunch_info = NULL;
	reg.id = id;
	reg.busy = 1;
	say("info", "pairing with %s (%s)", host, reg.ps5 ? "PS5" : "PS4");
	ChiakiErrorCode err = chiaki_regist_start(&reg.regist, &clog, &info, regist_cb, NULL);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		reg.busy = 0;
		reply_err(id, "pairing could not start: %s", chiaki_error_string(err));
	}
}

static void reg_cleanup(void)
{
	if(reg.busy == 2)
	{
		chiaki_regist_fini(&reg.regist);
		reg.busy = 0;
	}
}

/* ======================================================================== the session */
static struct {
	int running;            /* 1 running, 2 ended (the main loop cleans up) */
	ChiakiSession session;
	char host[128];
	int video;              /* the video tool's stream socket */
	char video_path[256];
	char header[512];
	int frames;
	int streaming;
	pthread_mutex_t lock;
} ses = { .video = -1, .lock = PTHREAD_MUTEX_INITIALIZER };

static int video_connect(void)
{
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if(fd < 0)
		return -1;
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", ses.video_path);
	if(connect(fd, (struct sockaddr *)&a, sizeof(a)) < 0)
	{
		say("warn", "video tool: %s: %s", ses.video_path, strerror(errno));
		close(fd);
		return -1;
	}
	size_t len = strlen(ses.header);
	if(write(fd, ses.header, len) != (ssize_t)len)
	{
		close(fd);
		return -1;
	}
	return fd;
}

static int write_all(int fd, const uint8_t *buf, size_t size)
{
	while(size)
	{
		ssize_t w = write(fd, buf, size);
		if(w < 0 && errno == EINTR)
			continue;
		if(w <= 0)
			return -1;
		buf += w;
		size -= (size_t)w;
	}
	return 0;
}

/* each frame, Annex B, straight to the video tool; a lost connection is opened again at the next keyframe request */
static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)frames_lost; (void)frame_recovered; (void)user;
	pthread_mutex_lock(&ses.lock);
	if(ses.video < 0)
	{
		ses.video = video_connect();
		if(ses.video >= 0)
			chiaki_session_request_idr(&ses.session);    /* the decoder starts on a keyframe */
	}
	if(ses.video >= 0 && write_all(ses.video, buf, buf_size) < 0)
	{
		say("warn", "video tool: the stream socket closed");
		close(ses.video);
		ses.video = -1;
	}
	ses.frames++;
	int first = !ses.streaming;
	ses.streaming = 1;
	pthread_mutex_unlock(&ses.lock);
	if(first)
		session_event("streaming", NULL);
	return true;
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			say("info", "connected to %s", ses.host);
			session_event("connecting", "connected, waiting for the picture");
			break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			say("warn", "the console asks for its login PIN");
			session_event("ended", "the console asks for a login PIN: switch it off on the console (Settings > Users and Accounts) to play from the car");
			chiaki_session_stop(&ses.session);
			break;
		case CHIAKI_EVENT_QUIT:
		{
			char reason[256];
			snprintf(reason, sizeof(reason), "%s%s%s", chiaki_quit_reason_string(event->quit.reason),
				event->quit.reason_str ? ": " : "", event->quit.reason_str ? event->quit.reason_str : "");
			say("info", "session ended: %s", reason);
			session_event("ended", reason);
			ses.running = 2;
			break;
		}
		default:
			break;
	}
}

static void do_start(int id, json_object *m)
{
	if(ses.running)
	{
		reply_err(id, "a session is already running");
		return;
	}
	const char *host = str_of(m, "host");
	json_object *r = obj_of(m, "registered"), *v = obj_of(m, "video");
	if(!host || !r || !v)
	{
		reply_err(id, "start needs host, registered and video");
		return;
	}
	ChiakiConnectInfo ci;
	memset(&ci, 0, sizeof(ci));
	snprintf(ses.host, sizeof(ses.host), "%s", host);
	ci.ps5 = !is_ps4(m);
	ci.host = ses.host;
	if(b64_decode_exact(str_of(r, "rpRegistKey"), (uint8_t *)ci.regist_key, sizeof(ci.regist_key)) < 0
		|| b64_decode_exact(str_of(r, "rpKey"), ci.morning, sizeof(ci.morning)) < 0)
	{
		reply_err(id, "the pairing is incomplete: pair again");
		return;
	}
	const char *account = str_of(m, "accountId");
	if(account)
		b64_decode_exact(account, ci.psn_account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE);
	int height = int_of(v, "height", 720), fps = int_of(v, "fps", 60);
	chiaki_connect_video_profile_preset(&ci.video_profile,
		height >= 1080 ? CHIAKI_VIDEO_RESOLUTION_PRESET_1080p : height >= 720 ? CHIAKI_VIDEO_RESOLUTION_PRESET_720p
		: height >= 540 ? CHIAKI_VIDEO_RESOLUTION_PRESET_540p : CHIAKI_VIDEO_RESOLUTION_PRESET_360p,
		fps >= 60 ? CHIAKI_VIDEO_FPS_PRESET_60 : CHIAKI_VIDEO_FPS_PRESET_30);
	const char *codec = str_of(v, "codec");
	if(ci.ps5 && codec && !strcmp(codec, "h265"))
		ci.video_profile.codec = CHIAKI_CODEC_H265;
	int kbps = int_of(v, "bitrateKbps", 0);
	if(kbps >= 2000 && kbps <= 50000)
		ci.video_profile.bitrate = (unsigned)kbps;
	ci.video_profile_auto_downgrade = true;
	ci.enable_keyboard = false;
	ci.enable_dualsense = ci.ps5;
	ci.audio_video_disabled = CHIAKI_AUDIO_DISABLED;
	ci.auto_regist = false;
	ci.packet_loss_max = 0.05;
	ci.enable_idr_on_fec_failure = true;

	/* the video tool gets this line first, then the frames */
	const char *vsock = str_of(v, "socket");
	snprintf(ses.video_path, sizeof(ses.video_path), "%s", vsock ? vsock : "/run/ida-remoteplay-video/stream.sock");
	json_object *head = json_object_new_object();
	json_object_object_add(head, "codec", json_object_new_string(ci.video_profile.codec == CHIAKI_CODEC_H264 ? "h264" : "h265"));
	json_object_object_add(head, "width", json_object_new_int((int)ci.video_profile.width));
	json_object_object_add(head, "height", json_object_new_int((int)ci.video_profile.height));
	json_object_object_add(head, "fps", json_object_new_int((int)ci.video_profile.max_fps));
	json_object *rect = obj_of(v, "rect");
	if(rect)
		json_object_object_add(head, "rect", json_object_get(rect));
	snprintf(ses.header, sizeof(ses.header), "%s\n", json_object_to_json_string_ext(head, JSON_C_TO_STRING_PLAIN));
	json_object_put(head);

	ChiakiErrorCode err = chiaki_session_init(&ses.session, &ci, &clog);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		reply_err(id, "session: %s", chiaki_error_string(err));
		return;
	}
	chiaki_session_set_event_cb(&ses.session, event_cb, NULL);
	chiaki_session_set_video_sample_cb(&ses.session, video_cb, NULL);
	ses.frames = 0;
	ses.streaming = 0;
	err = chiaki_session_start(&ses.session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_session_fini(&ses.session);
		reply_err(id, "session could not start: %s", chiaki_error_string(err));
		return;
	}
	ses.running = 1;
	say("info", "session to %s: %ux%u %u fps %s, %u kbps", ses.host, ci.video_profile.width, ci.video_profile.height,
		ci.video_profile.max_fps, ci.video_profile.codec == CHIAKI_CODEC_H264 ? "h264" : "h265", ci.video_profile.bitrate);
	session_event("connecting", NULL);
	reply_ok(id, NULL);
}

static void ses_end(void)
{
	if(!ses.running)
		return;
	chiaki_session_stop(&ses.session);
	chiaki_session_join(&ses.session);
	chiaki_session_fini(&ses.session);
	pthread_mutex_lock(&ses.lock);
	if(ses.video >= 0)
	{
		close(ses.video);
		ses.video = -1;
	}
	pthread_mutex_unlock(&ses.lock);
	say("info", "session closed after %d frames", ses.frames);
	ses.running = 0;
}

/* the app's names -> the controller's buttons */
static const struct { const char *name; uint32_t bit; } BUTTONS[] = {
	{ "cross", CHIAKI_CONTROLLER_BUTTON_CROSS }, { "circle", CHIAKI_CONTROLLER_BUTTON_MOON },
	{ "square", CHIAKI_CONTROLLER_BUTTON_BOX }, { "triangle", CHIAKI_CONTROLLER_BUTTON_PYRAMID },
	{ "left", CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT }, { "right", CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT },
	{ "up", CHIAKI_CONTROLLER_BUTTON_DPAD_UP }, { "down", CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN },
	{ "l1", CHIAKI_CONTROLLER_BUTTON_L1 }, { "r1", CHIAKI_CONTROLLER_BUTTON_R1 },
	{ "l3", CHIAKI_CONTROLLER_BUTTON_L3 }, { "r3", CHIAKI_CONTROLLER_BUTTON_R3 },
	{ "options", CHIAKI_CONTROLLER_BUTTON_OPTIONS }, { "create", CHIAKI_CONTROLLER_BUTTON_SHARE },
	{ "touchpad", CHIAKI_CONTROLLER_BUTTON_TOUCHPAD }, { "ps", CHIAKI_CONTROLLER_BUTTON_PS },
};

static int16_t axis(json_object *st, const char *key)
{
	int v = int_of(st, key, 0);
	return (int16_t)(v < -32768 ? -32768 : v > 32767 ? 32767 : v);
}

static void do_input(json_object *m)
{
	json_object *st = obj_of(m, "state");
	if(!st || ses.running != 1)
		return;
	ChiakiControllerState cs;
	chiaki_controller_state_set_idle(&cs);
	json_object *b;
	if(json_object_object_get_ex(st, "buttons", &b) && json_object_is_type(b, json_type_array))
	{
		size_t n = json_object_array_length(b);
		for(size_t i = 0; i < n; i++)
		{
			const char *name = json_object_get_string(json_object_array_get_idx(b, i));
			for(size_t k = 0; name && k < sizeof(BUTTONS) / sizeof(BUTTONS[0]); k++)
				if(!strcmp(name, BUTTONS[k].name))
					cs.buttons |= BUTTONS[k].bit;
		}
	}
	int l2 = int_of(st, "l2", 0), r2 = int_of(st, "r2", 0);
	cs.l2_state = (uint8_t)(l2 < 0 ? 0 : l2 > 255 ? 255 : l2);
	cs.r2_state = (uint8_t)(r2 < 0 ? 0 : r2 > 255 ? 255 : r2);
	cs.left_x = axis(st, "lx"); cs.left_y = axis(st, "ly");
	cs.right_x = axis(st, "rx"); cs.right_y = axis(st, "ry");
	chiaki_session_set_controller_state(&ses.session, &cs);
}

/* ======================================================================== the socket */
static void handle(json_object *m)
{
	const char *op = str_of(m, "op");
	int id = int_of(m, "id", 0);
	if(!op)
		return;
	if(!strcmp(op, "input"))
		do_input(m);
	else if(!strcmp(op, "hello"))
	{
		json_object *o = json_object_new_object();
		json_object_object_add(o, "name", json_object_new_string("Remote Play Engine (chiaki-ng)"));
		json_object_object_add(o, "version", json_object_new_string(ENGINE_VERSION));
		json_object *t = json_object_new_array();
		json_object_array_add(t, json_object_new_string("ps5"));
		json_object_array_add(t, json_object_new_string("ps4"));
		json_object_object_add(o, "targets", t);
		reply_ok(id, o);
	}
	else if(!strcmp(op, "register"))
		do_register(id, m);
	else if(!strcmp(op, "start"))
		do_start(id, m);
	else if(!strcmp(op, "stop"))
	{
		ses_end();
		reply_ok(id, NULL);
	}
	else
		reply_err(id, "unknown op %s", op);
}

static volatile sig_atomic_t quit;
static void on_signal(int s) { (void)s; quit = 1; }

int main(int argc, char **argv)
{
	const char *run = argc > 1 ? argv[1] : DEFAULT_RUN;
	signal(SIGPIPE, SIG_IGN);
	signal(SIGTERM, on_signal);
	signal(SIGINT, on_signal);
	setvbuf(stdout, NULL, _IOLBF, 0);
	chiaki_log_init(&clog, CHIAKI_LOG_ALL & ~(CHIAKI_LOG_VERBOSE | CHIAKI_LOG_DEBUG), chiaki_log_cb, NULL);
	ChiakiErrorCode err = chiaki_lib_init();
	if(err != CHIAKI_ERR_SUCCESS)
	{
		say("error", "chiaki_lib_init: %s", chiaki_error_string(err));
		return 1;
	}
	mkdir(run, 0755);
	snprintf(sock_path, sizeof(sock_path), "%s/engine.sock", run);
	unlink(sock_path);
	int lfd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", sock_path);
	if(lfd < 0 || bind(lfd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(lfd, 2) < 0)
	{
		say("error", "socket %s: %s", sock_path, strerror(errno));
		return 1;
	}
	chmod(sock_path, 0666);
	say("info", "Remote Play Engine %s on %s", ENGINE_VERSION, sock_path);

	char buf[16384];
	size_t fill = 0;
	while(!quit)
	{
		struct pollfd p[2] = { { .fd = lfd, .events = POLLIN }, { .fd = client, .events = POLLIN } };
		int r = poll(p, client >= 0 ? 2 : 1, 250);
		reg_cleanup();
		if(ses.running == 2)
			ses_end();
		if(r <= 0)
			continue;
		if(p[0].revents & POLLIN)
		{
			int c = accept(lfd, NULL, NULL);
			if(c >= 0)
			{
				pthread_mutex_lock(&out_lock);
				if(client >= 0)
					close(client);       /* a new app connection replaces the old */
				client = c;
				pthread_mutex_unlock(&out_lock);
				fill = 0;
				say("info", "app connected");
			}
			continue;
		}
		if(client >= 0 && (p[1].revents & (POLLIN | POLLHUP | POLLERR)))
		{
			ssize_t n = read(client, buf + fill, sizeof(buf) - 1 - fill);
			if(n <= 0)
			{
				say("info", "app went away%s", ses.running ? ": stopping the session" : "");
				pthread_mutex_lock(&out_lock);
				close(client);
				client = -1;
				pthread_mutex_unlock(&out_lock);
				ses_end();
				continue;
			}
			fill += (size_t)n;
			buf[fill] = 0;
			char *line = buf, *nl;
			while((nl = memchr(line, '\n', fill - (size_t)(line - buf))))
			{
				*nl = 0;
				json_object *m = json_tokener_parse(line);
				if(m)
				{
					handle(m);
					json_object_put(m);
				}
				line = nl + 1;
			}
			fill -= (size_t)(line - buf);
			memmove(buf, line, fill);
			if(fill >= sizeof(buf) - 1)
				fill = 0;              /* a line too long for anything here: dropped */
		}
	}
	ses_end();
	if(reg.busy)
	{
		chiaki_regist_stop(&reg.regist);
		chiaki_regist_fini(&reg.regist);
	}
	unlink(sock_path);
	say("info", "stopped");
	return 0;
}
