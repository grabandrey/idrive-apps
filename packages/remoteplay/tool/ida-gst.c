/*
 * Remote Play Video: ida-gst, a small stand-in for gst-launch-1.0 and gst-inspect-1.0, which head units often leave
 * out even though their media player has GStreamer's libraries and the hardware decoder's plugin. It loads the head
 * unit's own libgstreamer-1.0 at run time (dlopen), so it needs nothing else and works with whatever version is there.
 *
 *   ida-gst probe                    "version 1.20.3", then one line per element: element<TAB>name<TAB>rank<TAB>klass
 *   ida-gst launch <pipeline words>  runs the pipeline as gst-launch-1.0 does: prints "Setting pipeline to PLAYING",
 *                                    "ERROR: ..." on an error (exit 1), exits 0 at the end of the stream or on SIGINT
 *
 * Built by build_gst.sh against an old glibc (2.17), dynamically, for x86_64 and aarch64. MIT licensed.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* the few GLib/GStreamer types used, by their stable public layout */
typedef struct { uint32_t domain; int code; char *message; } GError;
typedef struct GList { void *data; struct GList *next; struct GList *prev; } GList;
enum { STATE_NULL = 1, STATE_PLAYING = 4 };
enum { MSG_EOS = 1 << 0, MSG_ERROR = 1 << 1 };
/* GstMessage's start, GStreamer 1.x's public ABI: the mini object, then the message type */
typedef struct {
	size_t type; int refcount; int lockstate; unsigned flags;
	void *copy, *dispose, *free; unsigned priv_uint; void *priv_pointer;
} GstMiniObjectHead;
typedef struct { GstMiniObjectHead mini; unsigned type; } GstMessageHead;

static struct {
	void (*init)(int *, char ***);
	void (*version)(unsigned *, unsigned *, unsigned *, unsigned *);
	void *(*parse_launch)(const char *, GError **);
	int (*set_state)(void *, int);
	void *(*get_bus)(void *);
	void *(*pop)(void *, uint64_t, int);
	void (*parse_error)(void *, GError **, char **);
	void (*mini_unref)(void *);
	void (*object_unref)(void *);
	void *(*registry_get)(void);
	GList *(*feature_list)(void *, size_t);
	size_t (*factory_type)(void);
	char *(*object_name)(void *);
	const char *(*metadata)(void *, const char *);
	unsigned (*rank)(void *);
	void (*list_free)(GList *);
	void (*g_free)(void *);
} G;

static const char *LIBS[] = {
	"libgstreamer-1.0.so.0", "/usr/lib/libgstreamer-1.0.so.0", "/usr/lib64/libgstreamer-1.0.so.0", "/lib/libgstreamer-1.0.so.0",
	"/usr/lib/x86_64-linux-gnu/libgstreamer-1.0.so.0", "/usr/lib/aarch64-linux-gnu/libgstreamer-1.0.so.0",
	"/usr/local/lib/libgstreamer-1.0.so.0", NULL
};

static void *sym(void *h, const char *name)
{
	void *p = dlsym(h, name);
	if(!p)
		p = dlsym(RTLD_DEFAULT, name);
	if(!p)
	{
		printf("ERROR: GStreamer has no %s\n", name);
		exit(3);
	}
	return p;
}

static void load(void)
{
	void *h = NULL;
	const char *env = getenv("IDA_GST_LIB");
	if(env)
		h = dlopen(env, RTLD_NOW | RTLD_GLOBAL);
	for(int i = 0; !h && LIBS[i]; i++)
		h = dlopen(LIBS[i], RTLD_NOW | RTLD_GLOBAL);
	if(!h)
	{
		printf("ERROR: no GStreamer library (libgstreamer-1.0.so.0) on this head unit: %s\n", dlerror());
		exit(2);
	}
	*(void **)&G.init = sym(h, "gst_init");
	*(void **)&G.version = sym(h, "gst_version");
	*(void **)&G.parse_launch = sym(h, "gst_parse_launch");
	*(void **)&G.set_state = sym(h, "gst_element_set_state");
	*(void **)&G.get_bus = sym(h, "gst_element_get_bus");
	*(void **)&G.pop = sym(h, "gst_bus_timed_pop_filtered");
	*(void **)&G.parse_error = sym(h, "gst_message_parse_error");
	*(void **)&G.mini_unref = sym(h, "gst_mini_object_unref");
	*(void **)&G.object_unref = sym(h, "gst_object_unref");
	*(void **)&G.registry_get = sym(h, "gst_registry_get");
	*(void **)&G.feature_list = sym(h, "gst_registry_get_feature_list");
	*(void **)&G.factory_type = sym(h, "gst_element_factory_get_type");
	*(void **)&G.object_name = sym(h, "gst_object_get_name");
	*(void **)&G.metadata = sym(h, "gst_element_factory_get_metadata");
	*(void **)&G.rank = sym(h, "gst_plugin_feature_get_rank");
	*(void **)&G.list_free = sym(h, "gst_plugin_feature_list_free");
	*(void **)&G.g_free = sym(h, "g_free");
	G.init(NULL, NULL);
}

static int probe(void)
{
	unsigned a, b, c, d;
	G.version(&a, &b, &c, &d);
	printf("version %u.%u.%u\n", a, b, c);
	GList *list = G.feature_list(G.registry_get(), G.factory_type());
	for(GList *l = list; l; l = l->next)
	{
		char *name = G.object_name(l->data);
		const char *klass = G.metadata(l->data, "klass");
		printf("element\t%s\t%u\t%s\n", name ? name : "?", G.rank(l->data), klass ? klass : "");
		G.g_free(name);
	}
	G.list_free(list);
	fflush(stdout);
	return 0;
}

static volatile sig_atomic_t stop;
static void on_signal(int s) { (void)s; stop = 1; }

static int launch(int argc, char **argv)
{
	size_t len = 1;
	for(int i = 0; i < argc; i++)
		len += strlen(argv[i]) + 1;
	char *desc = calloc(1, len);
	for(int i = 0; i < argc; i++)
	{
		strcat(desc, argv[i]);
		if(i + 1 < argc)
			strcat(desc, " ");
	}
	GError *err = NULL;
	void *pipeline = G.parse_launch(desc, &err);
	if(!pipeline || err)
	{
		/* as gst-launch-1.0: an erroneous pipeline (a missing element, a bad property) isn't run at all */
		printf("ERROR: the pipeline: %s\n", err && err->message ? err->message : "could not be made");
		fflush(stdout);
		if(pipeline)
			G.object_unref(pipeline);
		return 1;
	}
	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	signal(SIGPIPE, SIG_IGN);
	void *bus = G.get_bus(pipeline);
	if(!bus)
	{
		printf("ERROR: the pipeline has no message bus\n");
		G.object_unref(pipeline);
		return 1;
	}
	if(G.set_state(pipeline, STATE_PLAYING) == 0)
	{
		printf("ERROR: the pipeline refused to play\n");
		fflush(stdout);
		G.set_state(pipeline, STATE_NULL);
		return 1;
	}
	printf("Setting pipeline to PLAYING ...\n");
	fflush(stdout);
	int code = 0;
	/* one wait for both: gst_bus_timed_pop_filtered drops whatever it pops that doesn't match its filter */
	while(!stop)
	{
		void *m = G.pop(bus, 100000000ULL, MSG_ERROR | MSG_EOS);       /* 100 ms, so a signal is seen */
		if(!m)
			continue;
		if(((GstMessageHead *)m)->type & MSG_ERROR)
		{
			GError *e = NULL;
			char *debug = NULL;
			G.parse_error(m, &e, &debug);
			printf("ERROR: %s%s%s\n", e && e->message ? e->message : "unknown", debug ? " | " : "", debug ? debug : "");
			code = 1;
		}
		else
			printf("Got EOS from element \"pipeline\".\n");
		fflush(stdout);
		G.mini_unref(m);
		break;
	}
	G.set_state(pipeline, STATE_NULL);
	G.object_unref(bus);
	G.object_unref(pipeline);
	return code;
}

int main(int argc, char **argv)
{
	if(argc < 2 || (strcmp(argv[1], "probe") && strcmp(argv[1], "launch")))
	{
		fprintf(stderr, "usage: ida-gst probe | ida-gst launch <pipeline>\n");
		return 64;
	}
	setvbuf(stdout, NULL, _IOLBF, 0);
	load();
	return !strcmp(argv[1], "probe") ? probe() : launch(argc - 2, argv + 2);
}
