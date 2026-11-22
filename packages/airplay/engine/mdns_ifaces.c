// SPDX-License-Identifier: LGPL-2.1-or-later
/*
 * AirPlay Engine: how the phone finds the car, behind UxPlay's lib/mdnsd/dnssd_mdnsd.c (the same mdnsd.h interface,
 * in place of lib/mdnsd/mdnsd.c, which answers on one interface only: the one the default route picks).
 *
 * 1. The head unit's own Bonjour daemon, when it has one (wireless CarPlay runs on Apple's mDNSResponder): the two
 *    services are registered with it over its socket (/var/run/mDNSResponder, /var/run/mdnsd, ...), the way
 *    DNSServiceRegister does, so it announces them on every network it serves, the CarPlay Wi-Fi link included, over
 *    IPv4 and IPv6, with its own host name. The registration lasts as long as the socket.
 * 2. Otherwise its own responder: on every interface that is up (loopback aside), IPv4 (A records) and IPv6 (AAAA,
 *    the link-local address: an iPhone on the car's Wi-Fi reaches it there), each with that interface's own address.
 *    New interfaces are looked for every 5 s (a hotspot that comes up later) and announced on.
 *
 * Settings (the engine's environment, /var/opt/ida-airplay-engine/env):
 *   IDA_MDNS_IFACES=wlan0,uap0   only these interfaces (own responder)
 *   IDA_MDNS_SKIP=eth0,eth1      not these
 *   IDA_MDNS_SYSTEM=0            never the head unit's daemon; =1 only it
 *   IDA_MDNS_SOCKET=/path        the daemon's socket, when it's somewhere else
 *
 * What it does is reported through ida_mdns_report (the engine passes it on to the app).
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "mdnsd.h"

#define MDNS_ADDR4 "224.0.0.251"
#define MDNS_ADDR6 "ff02::fb"
#define MDNS_PORT 5353
#define MDNS_MAX_PACKET 1500
#define MDNS_TTL_HOST 120
#define MAX_IFACES 24
#define SCAN_SECONDS 5

#define DNS_TYPE_A 1
#define DNS_TYPE_PTR 12
#define DNS_TYPE_TXT 16
#define DNS_TYPE_AAAA 28
#define DNS_TYPE_SRV 33
#define DNS_TYPE_ANY 255
#define DNS_CLASS_IN 1
#define DNS_CACHE_FLUSH 0x8000
#define DNS_UNICAST_RESPONSE 0x8000

/* the engine's: what the phone can find, in words (or NULL) */
void (*ida_mdns_report)(const char *how) = NULL;

typedef struct { unsigned char bytes[MDNS_MAX_PACKET]; size_t length; } packet_t;
typedef struct {
	int index;
	char name[IF_NAMESIZE];
	uint32_t addr4;          /* 0: none */
	unsigned char addr6[16];
	int has6, joined4, joined6, seen;
} iface_t;

struct mdnsd_s {
	char host_name[MDNSD_MAX_NAME];
	mdnsd_service_t airplay, raop;
	iface_t ifaces[MAX_IFACES];
	int n_ifaces;
	int fd4, fd6;
	int running;
	int system;              /* registered with the head unit's daemon */
	int sys_fd[2];           /* its sockets: airplay, raop */
	char sys_path[108];
	pthread_t thread;
	pthread_mutex_t mutex;
	time_t scanned;
	char report[1024];
};

static void note(const char *fmt, const char *a, const char *b)
{
	printf("[info] mdns: ");
	printf(fmt, a, b);
	printf("\n");
	fflush(stdout);
}

static void report(mdnsd_t *m)
{
	char r[1024];
	if(m->system) snprintf(r, sizeof(r), "through the head unit's Bonjour (%s)", m->sys_path);
	else
	{
		size_t o = 0;
		r[0] = 0;
		for(int i = 0; i < m->n_ifaces && o < sizeof(r) - 80; i++)
		{
			char a4[INET_ADDRSTRLEN] = "", a6[INET6_ADDRSTRLEN] = "";
			iface_t *f = &m->ifaces[i];
			if(f->addr4 && f->joined4) inet_ntop(AF_INET, &f->addr4, a4, sizeof(a4));
			if(f->has6 && f->joined6) inet_ntop(AF_INET6, f->addr6, a6, sizeof(a6));
			if(!a4[0] && !a6[0]) continue;
			o += (size_t)snprintf(r + o, sizeof(r) - o, "%s%s %s%s%s", o ? ", " : "", f->name, a4, a4[0] && a6[0] ? " " : "", a6);
		}
		if(!o) snprintf(r, sizeof(r), "no network to announce on yet");
	}
	if(!strcmp(r, m->report)) return;
	snprintf(m->report, sizeof(m->report), "%s", r);
	note("announced %s%s", r, "");
	if(ida_mdns_report) ida_mdns_report(r);
}

/* ---- packets ---- */
static int put_u8(packet_t *p, unsigned v) { if(p->length + 1 > sizeof(p->bytes)) return -1; p->bytes[p->length++] = (unsigned char)v; return 0; }
static int put_u16(packet_t *p, unsigned v) { return put_u8(p, (v >> 8) & 0xff) || put_u8(p, v & 0xff); }
static int put_u32(packet_t *p, uint32_t v) { return put_u16(p, (v >> 16) & 0xffff) || put_u16(p, v & 0xffff); }
static int put_bytes(packet_t *p, const void *b, size_t n)
{
	if(p->length + n > sizeof(p->bytes)) return -1;
	memcpy(p->bytes + p->length, b, n);
	p->length += n;
	return 0;
}
static int put_name(packet_t *p, const char *name)
{
	const char *label = name;
	while(label && *label)
	{
		const char *dot = strchr(label, '.');
		size_t len = dot ? (size_t)(dot - label) : strlen(label);
		if(len > 63 || put_u8(p, (unsigned)len) || put_bytes(p, label, len)) return -1;
		if(!dot) break;
		label = dot + 1;
	}
	return put_u8(p, 0);
}
static int begin_rr(packet_t *p, const char *name, unsigned type, unsigned cls, uint32_t ttl, size_t *len_at)
{
	if(put_name(p, name) || put_u16(p, type) || put_u16(p, cls) || put_u32(p, ttl)) return -1;
	*len_at = p->length;
	return put_u16(p, 0);
}
static void end_rr(packet_t *p, size_t len_at)
{
	size_t n = p->length - len_at - 2;
	p->bytes[len_at] = (unsigned char)(n >> 8);
	p->bytes[len_at + 1] = (unsigned char)n;
}
static int add_ptr(packet_t *p, const char *name, const char *to, uint32_t ttl)
{
	size_t at;
	if(begin_rr(p, name, DNS_TYPE_PTR, DNS_CLASS_IN, ttl, &at) || put_name(p, to)) return -1;
	end_rr(p, at);
	return 0;
}
static int add_srv(packet_t *p, const char *name, unsigned short port, const char *target, uint32_t ttl)
{
	size_t at;
	if(begin_rr(p, name, DNS_TYPE_SRV, DNS_CLASS_IN | DNS_CACHE_FLUSH, ttl, &at) || put_u16(p, 0) || put_u16(p, 0) ||
		put_u16(p, port) || put_name(p, target)) return -1;
	end_rr(p, at);
	return 0;
}
static int add_txt(packet_t *p, const char *name, const mdnsd_txt_t *txt, uint32_t ttl)
{
	size_t at;
	if(begin_rr(p, name, DNS_TYPE_TXT, DNS_CLASS_IN | DNS_CACHE_FLUSH, ttl, &at) || put_bytes(p, txt->bytes, (size_t)txt->length)) return -1;
	end_rr(p, at);
	return 0;
}
static int add_addr(packet_t *p, const char *name, int six, const void *addr, uint32_t ttl)
{
	size_t at;
	if(begin_rr(p, name, six ? DNS_TYPE_AAAA : DNS_TYPE_A, DNS_CLASS_IN | DNS_CACHE_FLUSH, ttl, &at) || put_bytes(p, addr, six ? 16 : 4)) return -1;
	end_rr(p, at);
	return 0;
}

/* one response: the services asked for (each: its type in the service list, its PTR, SRV, TXT) and the host's
 * address on the interface it goes out on (A over IPv4, AAAA over IPv6). ttl 0: a goodbye. */
static int build(mdnsd_t *m, packet_t *p, int airplay, int raop, int host, const iface_t *f, int six, uint32_t ttl)
{
	unsigned answers = 0;
	p->length = 0;
	if(put_u16(p, 0) || put_u16(p, 0x8400) || put_u16(p, 0) || put_u16(p, 0) || put_u16(p, 0) || put_u16(p, 0)) return -1;
	const mdnsd_service_t *list[2] = { airplay ? &m->airplay : NULL, raop ? &m->raop : NULL };
	for(int i = 0; i < 2; i++)
	{
		const mdnsd_service_t *s = list[i];
		if(!s || !s->registered) continue;
		if(add_ptr(p, "_services._dns-sd._udp.local", s->type, ttl) || add_ptr(p, s->type, s->name, ttl) ||
			add_srv(p, s->name, s->port, m->host_name, ttl ? MDNS_TTL_HOST : 0) || add_txt(p, s->name, &s->txt, ttl)) return -1;
		answers += 4;
	}
	if(host && (six ? f->has6 : f->addr4 != 0))
	{
		if(add_addr(p, m->host_name, six, six ? (const void *)f->addr6 : (const void *)&f->addr4, ttl ? MDNS_TTL_HOST : 0)) return -1;
		answers++;
	}
	p->bytes[6] = (unsigned char)(answers >> 8);
	p->bytes[7] = (unsigned char)answers;
	return answers ? 0 : -1;
}

/* out on one interface: multicast (to NULL) or straight back to whoever asked */
static void send_on(mdnsd_t *m, const iface_t *f, int six, const packet_t *p, const void *to)
{
	if(!p->length) return;
	if(!six)
	{
		if(m->fd4 < 0) return;
		struct sockaddr_in dst;
		if(to) dst = *(const struct sockaddr_in *)to;
		else
		{
			memset(&dst, 0, sizeof(dst));
			dst.sin_family = AF_INET;
			dst.sin_port = htons(MDNS_PORT);
			inet_pton(AF_INET, MDNS_ADDR4, &dst.sin_addr);
		}
		struct ip_mreqn mr;
		memset(&mr, 0, sizeof(mr));
		mr.imr_ifindex = f->index;
		mr.imr_address.s_addr = f->addr4;
		setsockopt(m->fd4, IPPROTO_IP, IP_MULTICAST_IF, &mr, sizeof(mr));
		sendto(m->fd4, p->bytes, p->length, 0, (struct sockaddr *)&dst, sizeof(dst));
	}
	else
	{
		if(m->fd6 < 0) return;
		struct sockaddr_in6 dst;
		if(to) dst = *(const struct sockaddr_in6 *)to;
		else
		{
			memset(&dst, 0, sizeof(dst));
			dst.sin6_family = AF_INET6;
			dst.sin6_port = htons(MDNS_PORT);
			dst.sin6_scope_id = (uint32_t)f->index;
			inet_pton(AF_INET6, MDNS_ADDR6, &dst.sin6_addr);
		}
		unsigned idx = (unsigned)f->index;
		setsockopt(m->fd6, IPPROTO_IPV6, IPV6_MULTICAST_IF, &idx, sizeof(idx));
		sendto(m->fd6, p->bytes, p->length, 0, (struct sockaddr *)&dst, sizeof(dst));
	}
}

static void respond(mdnsd_t *m, const iface_t *f, int six, int airplay, int raop, int host, uint32_t ttl, const void *to)
{
	packet_t p;
	if(airplay && raop && !build(m, &p, 1, 1, host, f, six, ttl) && p.length <= 1200) { send_on(m, f, six, &p, to); return; }
	if(airplay && !build(m, &p, 1, 0, host, f, six, ttl)) send_on(m, f, six, &p, to);
	if(raop && !build(m, &p, 0, 1, host, f, six, ttl)) send_on(m, f, six, &p, to);
	if(host && !airplay && !raop && !build(m, &p, 0, 0, 1, f, six, ttl)) send_on(m, f, six, &p, to);
}

static void respond_both(mdnsd_t *m, const iface_t *f, int airplay, int raop, int host, uint32_t ttl)
{
	if(f->joined4) respond(m, f, 0, airplay, raop, host, ttl, NULL);
	if(f->joined6) respond(m, f, 1, airplay, raop, host, ttl, NULL);
}

/* ---- which interfaces ---- */
static int in_list(const char *list, const char *name)
{
	size_t n = strlen(name);
	for(const char *s = list; s && *s; )
	{
		const char *e = strchr(s, ',');
		size_t len = e ? (size_t)(e - s) : strlen(s);
		if(len == n && !strncmp(s, name, n)) return 1;
		if(!e) break;
		s = e + 1;
	}
	return 0;
}
static int allowed(const char *name)
{
	const char *only = getenv("IDA_MDNS_IFACES"), *skip = getenv("IDA_MDNS_SKIP");
	if(only && *only && !in_list(only, name)) return 0;
	if(skip && *skip && in_list(skip, name)) return 0;
	return 1;
}

/* new interfaces joined and announced, gone ones dropped. Called with the lock held. */
static void scan(mdnsd_t *m)
{
	struct ifaddrs *list = NULL;
	m->scanned = time(NULL);
	if(getifaddrs(&list) == -1) return;
	for(int i = 0; i < m->n_ifaces; i++) m->ifaces[i].seen = 0;
	for(struct ifaddrs *a = list; a; a = a->ifa_next)
	{
		if(!a->ifa_addr || (a->ifa_addr->sa_family != AF_INET && a->ifa_addr->sa_family != AF_INET6) ||
			!(a->ifa_flags & IFF_UP) || (a->ifa_flags & IFF_LOOPBACK) || !allowed(a->ifa_name)) continue;
		int index = (int)if_nametoindex(a->ifa_name), k = -1;
		if(!index) continue;
		for(int i = 0; i < m->n_ifaces; i++) if(m->ifaces[i].index == index) k = i;
		if(k < 0)
		{
			if(m->n_ifaces >= MAX_IFACES) continue;
			k = m->n_ifaces++;
			memset(&m->ifaces[k], 0, sizeof(iface_t));
			m->ifaces[k].index = index;
			snprintf(m->ifaces[k].name, sizeof(m->ifaces[k].name), "%s", a->ifa_name);
		}
		iface_t *f = &m->ifaces[k];
		f->seen = 1;
		if(a->ifa_addr->sa_family == AF_INET) f->addr4 = ((struct sockaddr_in *)a->ifa_addr)->sin_addr.s_addr;
		else
		{
			struct in6_addr *x = &((struct sockaddr_in6 *)a->ifa_addr)->sin6_addr;
			/* the link-local address first: it's what a phone on the same Wi-Fi always reaches */
			if(!f->has6 || (IN6_IS_ADDR_LINKLOCAL(x) && !IN6_IS_ADDR_LINKLOCAL((struct in6_addr *)f->addr6)))
			{
				memcpy(f->addr6, x, 16);
				f->has6 = 1;
			}
		}
	}
	freeifaddrs(list);
	for(int i = 0; i < m->n_ifaces; )
	{
		if(m->ifaces[i].seen) { i++; continue; }
		note("%s gone%s", m->ifaces[i].name, "");
		m->ifaces[i] = m->ifaces[--m->n_ifaces];
	}
	for(int i = 0; i < m->n_ifaces; i++)
	{
		iface_t *f = &m->ifaces[i];
		int fresh = 0;
		if(f->addr4 && !f->joined4 && m->fd4 >= 0)
		{
			struct ip_mreqn mr;
			memset(&mr, 0, sizeof(mr));
			inet_pton(AF_INET, MDNS_ADDR4, &mr.imr_multiaddr);
			mr.imr_ifindex = f->index;
			if(setsockopt(m->fd4, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mr, sizeof(mr)) == 0 || errno == EADDRINUSE) fresh = f->joined4 = 1;
			else if(!f->joined4) { note("no IPv4 multicast on %s: %s", f->name, strerror(errno)); f->joined4 = -1; }
		}
		if(f->has6 && !f->joined6 && m->fd6 >= 0)
		{
			struct ipv6_mreq mr;
			memset(&mr, 0, sizeof(mr));
			inet_pton(AF_INET6, MDNS_ADDR6, &mr.ipv6mr_multiaddr);
			mr.ipv6mr_interface = (unsigned)f->index;
			if(setsockopt(m->fd6, IPPROTO_IPV6, IPV6_ADD_MEMBERSHIP, &mr, sizeof(mr)) == 0 || errno == EADDRINUSE) fresh = f->joined6 = 1;
			else if(!f->joined6) { note("no IPv6 multicast on %s: %s", f->name, strerror(errno)); f->joined6 = -1; }
		}
		if(fresh)
		{
			char a4[INET_ADDRSTRLEN] = "-", a6[INET6_ADDRSTRLEN] = "-";
			if(f->addr4) inet_ntop(AF_INET, &f->addr4, a4, sizeof(a4));
			if(f->has6) inet_ntop(AF_INET6, f->addr6, a6, sizeof(a6));
			printf("[info] mdns: on %s (%s, %s)\n", f->name, a4, a6);
			fflush(stdout);
			iface_t on = *f;
			on.joined4 = f->joined4 == 1; on.joined6 = f->joined6 == 1;
			respond_both(m, &on, 1, 1, 1, MDNSD_TTL_SERVICE);
		}
	}
	report(m);
}

/* ---- queries ---- */
static uint16_t rd16(const unsigned char *b) { return (uint16_t)((b[0] << 8) | b[1]); }
static int read_name(const unsigned char *pk, size_t len, size_t *off, char *out, size_t out_len)
{
	size_t pos = *off, o = 0;
	int jumped = 0, jumps = 0;
	while(pos < len)
	{
		unsigned l = pk[pos++];
		if(l == 0)
		{
			if(!jumped) *off = pos;
			if(o == 0) out[o++] = '.';
			out[o] = 0;
			return 0;
		}
		if((l & 0xc0) == 0xc0)
		{
			if(pos >= len || ++jumps > 16) return -1;
			size_t ptr = ((l & 0x3f) << 8) | pk[pos++];
			if(ptr >= len) return -1;
			if(!jumped) *off = pos;
			jumped = 1;
			pos = ptr;
			continue;
		}
		if(pos + l > len || o + l + 2 > out_len) return -1;
		if(o) out[o++] = '.';
		memcpy(out + o, pk + pos, l);
		o += l;
		pos += l;
	}
	return -1;
}
static int same(const char *a, const char *b) { return !strcasecmp(a, b); }
static int type_is(uint16_t t, uint16_t want) { return t == want || t == DNS_TYPE_ANY; }

static void query(mdnsd_t *m, const iface_t *f, int six, const unsigned char *b, size_t len, const void *from, uint16_t from_port)
{
	if(len < 12 || (rd16(b + 2) & 0x8000)) return;
	unsigned qd = rd16(b + 4);
	size_t off = 12;
	int airplay = 0, raop = 0, host = 0, unicast = 0;
	for(unsigned i = 0; i < qd; i++)
	{
		char name[MDNSD_MAX_NAME];
		if(read_name(b, len, &off, name, sizeof(name)) || off + 4 > len) break;
		uint16_t type = rd16(b + off), cls = rd16(b + off + 2);
		off += 4;
		if(cls & DNS_UNICAST_RESPONSE) unicast = 1;
		if(same(name, "_services._dns-sd._udp.local") && type_is(type, DNS_TYPE_PTR)) { airplay |= m->airplay.registered; raop |= m->raop.registered; }
		if(m->airplay.registered && ((same(name, m->airplay.type) && type_is(type, DNS_TYPE_PTR)) ||
			(same(name, m->airplay.name) && (type_is(type, DNS_TYPE_SRV) || type_is(type, DNS_TYPE_TXT))))) { airplay = 1; host = 1; }
		if(m->raop.registered && ((same(name, m->raop.type) && type_is(type, DNS_TYPE_PTR)) ||
			(same(name, m->raop.name) && (type_is(type, DNS_TYPE_SRV) || type_is(type, DNS_TYPE_TXT))))) { raop = 1; host = 1; }
		if(same(name, m->host_name) && type_is(type, six ? DNS_TYPE_AAAA : DNS_TYPE_A)) host = 1;
	}
	if(!airplay && !raop && !host) return;
	respond(m, f, six, airplay, raop, host, MDNSD_TTL_SERVICE, NULL);
	if(unicast || from_port != htons(MDNS_PORT)) respond(m, f, six, airplay, raop, host, MDNSD_TTL_SERVICE, from);
}

static void receive(mdnsd_t *m, int fd, int six)
{
	unsigned char buf[MDNS_MAX_PACKET], ctl[256];
	struct sockaddr_storage from;
	struct iovec iov = { buf, sizeof(buf) };
	struct msghdr msg;
	memset(&msg, 0, sizeof(msg));
	msg.msg_name = &from; msg.msg_namelen = sizeof(from);
	msg.msg_iov = &iov; msg.msg_iovlen = 1;
	msg.msg_control = ctl; msg.msg_controllen = sizeof(ctl);
	ssize_t n = recvmsg(fd, &msg, 0);
	if(n <= 0) return;
	int index = 0;
	for(struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
	{
		if(!six && c->cmsg_level == IPPROTO_IP && c->cmsg_type == IP_PKTINFO) index = ((struct in_pktinfo *)CMSG_DATA(c))->ipi_ifindex;
		if(six && c->cmsg_level == IPPROTO_IPV6 && c->cmsg_type == IPV6_PKTINFO) index = (int)((struct in6_pktinfo *)CMSG_DATA(c))->ipi6_ifindex;
	}
	uint16_t port = six ? ((struct sockaddr_in6 *)&from)->sin6_port : ((struct sockaddr_in *)&from)->sin_port;
	pthread_mutex_lock(&m->mutex);
	for(int i = 0; i < m->n_ifaces; i++)
		if(m->ifaces[i].index == index && (six ? m->ifaces[i].joined6 == 1 : m->ifaces[i].joined4 == 1))
		{
			iface_t f = m->ifaces[i];
			query(m, &f, six, buf, (size_t)n, &from, port);
			break;
		}
	pthread_mutex_unlock(&m->mutex);
}

static void *loop(void *arg)
{
	mdnsd_t *m = arg;
	for(;;)
	{
		pthread_mutex_lock(&m->mutex);
		int fd4 = m->fd4, fd6 = m->fd6, run = m->running;
		if(run && time(NULL) - m->scanned >= SCAN_SECONDS) scan(m);
		pthread_mutex_unlock(&m->mutex);
		if(!run) break;
		struct pollfd p[2] = { { fd4, POLLIN, 0 }, { fd6, POLLIN, 0 } };
		if(poll(p, 2, 250) <= 0) continue;
		if(fd4 >= 0 && (p[0].revents & POLLIN)) receive(m, fd4, 0);
		if(fd6 >= 0 && (p[1].revents & POLLIN)) receive(m, fd6, 1);
	}
	return NULL;
}

static int open4(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM, 0), one = 1;
	unsigned char ttl = 255, loopback = 1;
	if(fd < 0) return -errno;
	setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
	setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
#endif
	setsockopt(fd, IPPROTO_IP, IP_PKTINFO, &one, sizeof(one));
	setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
	setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loopback, sizeof(loopback));
	struct sockaddr_in a;
	memset(&a, 0, sizeof(a));
	a.sin_family = AF_INET;
	a.sin_port = htons(MDNS_PORT);
	a.sin_addr.s_addr = htonl(INADDR_ANY);
	if(bind(fd, (struct sockaddr *)&a, sizeof(a)) == -1) { int e = errno; close(fd); return -e; }
	return fd;
}

static int open6(void)
{
	int fd = socket(AF_INET6, SOCK_DGRAM, 0), one = 1, hops = 255;
	if(fd < 0) return -errno;
	setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
	setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
#endif
	setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof(one));
	setsockopt(fd, IPPROTO_IPV6, IPV6_RECVPKTINFO, &one, sizeof(one));
	setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_HOPS, &hops, sizeof(hops));
	setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_LOOP, &one, sizeof(one));
	struct sockaddr_in6 a;
	memset(&a, 0, sizeof(a));
	a.sin6_family = AF_INET6;
	a.sin6_port = htons(MDNS_PORT);
	a.sin6_addr = in6addr_any;
	if(bind(fd, (struct sockaddr *)&a, sizeof(a)) == -1) { int e = errno; close(fd); return -e; }
	return fd;
}

/* ---- the head unit's own Bonjour daemon (Apple's mDNSResponder): DNSServiceRegister's request on its socket ---- */
static const char *SYS_PATHS[] = { "/var/run/mDNSResponder", "/run/mDNSResponder", "/var/run/mdnsd", "/run/mdnsd",
	"/var/run/mdnsd.sock", "/tmp/mdnsd", NULL };

static const char *sys_path(void)
{
	const char *env = getenv("IDA_MDNS_SOCKET");
	struct stat st;
	if(env && *env) return env;
	for(int i = 0; SYS_PATHS[i]; i++) if(stat(SYS_PATHS[i], &st) == 0 && S_ISSOCK(st.st_mode)) return SYS_PATHS[i];
	return NULL;
}

static void p32(unsigned char **p, uint32_t v) { (*p)[0] = (unsigned char)(v >> 24); (*p)[1] = (unsigned char)(v >> 16); (*p)[2] = (unsigned char)(v >> 8); (*p)[3] = (unsigned char)v; *p += 4; }
static void pstr(unsigned char **p, const char *s) { size_t n = strlen(s) + 1; memcpy(*p, s, n); *p += n; }

/* "iDrive._airplay._tcp.local" of type "_airplay._tcp.local" -> name "iDrive", type "_airplay._tcp" */
static int split_service(const mdnsd_service_t *s, char *name, size_t nl, char *type, size_t tl)
{
	size_t n = strlen(s->name), t = strlen(s->type);
	if(n <= t + 1 || strcasecmp(s->name + n - t, s->type) || s->name[n - t - 1] != '.') return -1;
	snprintf(name, nl, "%.*s", (int)(n - t - 1), s->name);
	snprintf(type, tl, "%s", s->type);
	char *local = strstr(type, ".local");
	if(local && !local[6]) *local = 0;
	return 0;
}

/* one registration: its own connection, kept open (closing it deregisters). -> the socket, or -1 */
static int sys_register(const char *path, const mdnsd_service_t *s)
{
	char name[MDNSD_MAX_NAME], type[MDNSD_MAX_NAME];
	if(split_service(s, name, sizeof(name), type, sizeof(type))) return -1;
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	struct sockaddr_un a;
	memset(&a, 0, sizeof(a));
	a.sun_family = AF_UNIX;
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", path);
	if(fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof(a)) < 0) { if(fd >= 0) close(fd); return -1; }
	struct timeval tv = { 3, 0 };
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	unsigned char msg[28 + 8 + 3 * MDNSD_MAX_NAME + 8 + MDNSD_TXT_MAX], *p = msg + 28;
	p32(&p, 0);                       /* flags */
	p32(&p, 0);                       /* every interface */
	pstr(&p, name);
	pstr(&p, type);
	pstr(&p, "");                     /* domain: local */
	pstr(&p, "");                     /* host: the daemon's own */
	*p++ = (unsigned char)(s->port >> 8); *p++ = (unsigned char)s->port;
	*p++ = (unsigned char)(s->txt.length >> 8); *p++ = (unsigned char)s->txt.length;
	memcpy(p, s->txt.bytes, (size_t)s->txt.length); p += s->txt.length;
	uint32_t datalen = (uint32_t)(p - msg - 28);
	unsigned char *h = msg;
	p32(&h, 1);                       /* version */
	p32(&h, datalen);
	p32(&h, 0);                       /* ipc_flags */
	p32(&h, 5);                       /* reg_service_request */
	p32(&h, 0x69646101); p32(&h, 0);  /* client context */
	p32(&h, 0);                       /* reg_index */
	size_t len = (size_t)(p - msg), off = 0;
	while(off < len) { ssize_t w = write(fd, msg + off, len - off); if(w <= 0) { close(fd); return -1; } off += (size_t)w; }
	unsigned char e[4];
	size_t got = 0;
	while(got < 4) { ssize_t r = read(fd, e + got, 4 - got); if(r <= 0) { close(fd); return -1; } got += (size_t)r; }
	int32_t err = (int32_t)(((uint32_t)e[0] << 24) | ((uint32_t)e[1] << 16) | ((uint32_t)e[2] << 8) | e[3]);
	if(err) { char b[32]; snprintf(b, sizeof(b), "%d", err); note("the head unit's Bonjour refused %s: error %s", name, b); close(fd); return -1; }
	note("registered %s with the head unit's Bonjour (%s)", s->name, path);
	return fd;
}

/* the services not registered yet, registered; -> 0 when every registered service is */
static int sys_sync(mdnsd_t *m)
{
	const mdnsd_service_t *s[2] = { &m->airplay, &m->raop };
	int bad = 0;
	for(int i = 0; i < 2; i++)
	{
		if(!s[i]->registered) { if(m->sys_fd[i] >= 0) { close(m->sys_fd[i]); m->sys_fd[i] = -1; } continue; }
		if(m->sys_fd[i] < 0) m->sys_fd[i] = sys_register(m->sys_path, s[i]);
		if(m->sys_fd[i] < 0) bad = 1;
	}
	return bad ? -1 : 0;
}

static void sys_close(mdnsd_t *m)
{
	for(int i = 0; i < 2; i++) if(m->sys_fd[i] >= 0) { close(m->sys_fd[i]); m->sys_fd[i] = -1; }
	m->system = 0;
}

/* ---- mdnsd.h ---- */
int mdnsd_txt_add(mdnsd_txt_t *txt, const char *key, const char *value)
{
	char item[256];
	int len = snprintf(item, sizeof(item), "%s=%s", key, value ? value : "");
	if(len < 0 || len > 255 || txt->length + len + 1 > (int)sizeof(txt->bytes)) return -1;
	txt->bytes[txt->length++] = (unsigned char)len;
	memcpy(txt->bytes + txt->length, item, (size_t)len);
	txt->length += len;
	return 0;
}

mdnsd_t *mdnsd_init(const char *host_name)
{
	mdnsd_t *m = calloc(1, sizeof(*m));
	if(!m) return NULL;
	snprintf(m->host_name, sizeof(m->host_name), "%s", host_name && *host_name ? host_name : "idrive-airplay.local");
	m->fd4 = m->fd6 = -1;
	m->sys_fd[0] = m->sys_fd[1] = -1;
	pthread_mutex_init(&m->mutex, NULL);
	return m;
}

void mdnsd_destroy(mdnsd_t *m)
{
	if(!m) return;
	mdnsd_stop(m);
	pthread_mutex_destroy(&m->mutex);
	free(m);
}

int mdnsd_start(mdnsd_t *m)
{
	if(!m) return -1;
	pthread_mutex_lock(&m->mutex);
	if(m->system) { int r = sys_sync(m); pthread_mutex_unlock(&m->mutex); return r; }
	if(m->running) { pthread_mutex_unlock(&m->mutex); return 0; }
	const char *mode = getenv("IDA_MDNS_SYSTEM"), *path = mode && *mode == '0' ? NULL : sys_path();
	if(path)
	{
		snprintf(m->sys_path, sizeof(m->sys_path), "%s", path);
		if(!sys_sync(m)) { m->system = 1; report(m); pthread_mutex_unlock(&m->mutex); return 0; }
		sys_close(m);
		note("the head unit's Bonjour (%s) did not take the services: answering on my own%s", path, "");
	}
	if(mode && *mode == '1') { pthread_mutex_unlock(&m->mutex); return -1; }
	int fd4 = open4(), fd6 = open6();
	if(fd4 < 0 && fd6 < 0)
	{
		note("cannot listen on UDP 5353: %s%s", strerror(-fd4), "");
		pthread_mutex_unlock(&m->mutex);
		return fd4;
	}
	m->fd4 = fd4 < 0 ? -1 : fd4;
	m->fd6 = fd6 < 0 ? -1 : fd6;
	m->n_ifaces = 0;
	m->report[0] = 0;
	m->running = 1;
	scan(m);
	if(pthread_create(&m->thread, NULL, loop, m))
	{
		if(m->fd4 >= 0) close(m->fd4);
		if(m->fd6 >= 0) close(m->fd6);
		m->fd4 = m->fd6 = -1;
		m->running = 0;
		pthread_mutex_unlock(&m->mutex);
		return -1;
	}
	pthread_mutex_unlock(&m->mutex);
	return 0;
}

void mdnsd_stop(mdnsd_t *m)
{
	if(!m) return;
	pthread_mutex_lock(&m->mutex);
	sys_close(m);
	if(!m->running) { pthread_mutex_unlock(&m->mutex); return; }
	m->running = 0;
	pthread_t t = m->thread;
	pthread_mutex_unlock(&m->mutex);
	pthread_join(t, NULL);
	pthread_mutex_lock(&m->mutex);
	if(m->fd4 >= 0) close(m->fd4);
	if(m->fd6 >= 0) close(m->fd6);
	m->fd4 = m->fd6 = -1;
	m->n_ifaces = 0;
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_set_services(mdnsd_t *m, const mdnsd_service_t *airplay, const mdnsd_service_t *raop)
{
	if(!m) return;
	pthread_mutex_lock(&m->mutex);
	if(airplay) m->airplay = *airplay; else memset(&m->airplay, 0, sizeof(m->airplay));
	if(raop) m->raop = *raop; else memset(&m->raop, 0, sizeof(m->raop));
	if(m->system) sys_sync(m);
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_announce(mdnsd_t *m, uint32_t ttl)
{
	if(!m) return;
	pthread_mutex_lock(&m->mutex);
	if(!m->system) for(int i = 0; i < m->n_ifaces; i++) respond_both(m, &m->ifaces[i], 1, 1, 1, ttl);
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_goodbye(mdnsd_t *m, const mdnsd_service_t *service)
{
	if(!m || !service || !service->registered) return;
	pthread_mutex_lock(&m->mutex);
	if(m->system) { pthread_mutex_unlock(&m->mutex); return; }      /* set_services closes its registration */
	mdnsd_service_t keep_a = m->airplay, keep_r = m->raop;
	int is_airplay = !strcmp(service->type, keep_a.type);
	if(is_airplay) m->airplay = *service; else m->raop = *service;
	for(int i = 0; i < m->n_ifaces; i++)
	{
		iface_t f = m->ifaces[i];
		f.joined4 = f.joined4 == 1; f.joined6 = f.joined6 == 1;
		respond_both(m, &f, is_airplay, !is_airplay, 0, 0);
	}
	m->airplay = keep_a; m->raop = keep_r;
	pthread_mutex_unlock(&m->mutex);
}
