// SPDX-License-Identifier: LGPL-2.1-or-later
/*
 * AirPlay Engine: the mDNS responder behind UxPlay's lib/mdnsd/dnssd_mdnsd.c (the same mdnsd.h interface, in place
 * of lib/mdnsd/mdnsd.c). UxPlay's own answers on one interface only: the one the default route picks. A head unit
 * has several (its own internal networks, the car's hotspot, a phone's hotspot it joined), and the phone is rarely on
 * the default one. This one:
 *
 *   - answers on every IPv4 interface that is up and multicast-capable, with that interface's own address in the
 *     A record (so a phone on the hotspot gets the hotspot address, not an internal one)
 *   - by default only on private networks (10/8, 172.16/12, 192.168/16): the head unit's internal vehicle networks
 *     (160.48.x.x and the like) are left alone. IDA_MDNS_IFACES=wlan0,ap0 names the interfaces instead; IDA_MDNS_ALL=1
 *     allows every interface
 *   - looks for new interfaces every 5 s (a hotspot that comes up later) and announces itself on them
 *
 * IPv4 only: iPhones find AirPlay receivers over IPv4 on a hotspot. The record-building follows UxPlay's mdnsd.c.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "mdnsd.h"

#define MDNS_ADDR4 "224.0.0.251"
#define MDNS_PORT 5353
#define MDNS_MAX_PACKET 1500
#define MDNS_TTL_HOST 120
#define MAX_IFACES 16
#define SCAN_SECONDS 5

#define DNS_TYPE_A 1
#define DNS_TYPE_PTR 12
#define DNS_TYPE_TXT 16
#define DNS_TYPE_SRV 33
#define DNS_TYPE_ANY 255
#define DNS_CLASS_IN 1
#define DNS_CACHE_FLUSH 0x8000
#define DNS_UNICAST_RESPONSE 0x8000

typedef struct { unsigned char bytes[MDNS_MAX_PACKET]; size_t length; } packet_t;
typedef struct { int index; uint32_t addr; char name[IF_NAMESIZE]; int seen; } iface_t;

struct mdnsd_s {
	char host_name[MDNSD_MAX_NAME];
	mdnsd_service_t airplay, raop;
	iface_t ifaces[MAX_IFACES];
	int n_ifaces;
	int fd;
	int running;
	pthread_t thread;
	pthread_mutex_t mutex;
	time_t scanned;
};


static void note(const char *fmt, const char *a, const char *b)
{
	printf("[info] mdns: ");
	printf(fmt, a, b);
	printf("\n");
	fflush(stdout);
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
static int add_a(packet_t *p, const char *name, uint32_t addr, uint32_t ttl)
{
	size_t at;
	if(begin_rr(p, name, DNS_TYPE_A, DNS_CLASS_IN | DNS_CACHE_FLUSH, ttl, &at) || put_bytes(p, &addr, 4)) return -1;
	end_rr(p, at);
	return 0;
}

/* one response: the services asked for (each: its type in the service list, its PTR, SRV, TXT) and the host's A
 * record with the address of the interface it goes out on. ttl 0: a goodbye. */
static int build(mdnsd_t *m, packet_t *p, int airplay, int raop, int host, uint32_t addr, uint32_t ttl)
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
	if(host && addr)
	{
		if(add_a(p, m->host_name, addr, ttl ? MDNS_TTL_HOST : 0)) return -1;
		answers++;
	}
	p->bytes[6] = (unsigned char)(answers >> 8);
	p->bytes[7] = (unsigned char)answers;
	return answers ? 0 : -1;
}

/* out on one interface: multicast (to NULL) or straight back to whoever asked */
static void send_on(mdnsd_t *m, const iface_t *ifc, const packet_t *p, const struct sockaddr_in *to)
{
	struct sockaddr_in dst;
	if(m->fd < 0 || !p->length) return;
	if(to) dst = *to;
	else
	{
		memset(&dst, 0, sizeof(dst));
		dst.sin_family = AF_INET;
		dst.sin_port = htons(MDNS_PORT);
		inet_pton(AF_INET, MDNS_ADDR4, &dst.sin_addr);
	}
	struct ip_mreqn mr;
	memset(&mr, 0, sizeof(mr));
	mr.imr_ifindex = ifc->index;
	mr.imr_address.s_addr = ifc->addr;
	setsockopt(m->fd, IPPROTO_IP, IP_MULTICAST_IF, &mr, sizeof(mr));
	sendto(m->fd, p->bytes, p->length, 0, (struct sockaddr *)&dst, sizeof(dst));
}

static void respond(mdnsd_t *m, const iface_t *ifc, int airplay, int raop, int host, uint32_t ttl, const struct sockaddr_in *to)
{
	packet_t p;
	if(airplay && raop && !build(m, &p, 1, 1, host, ifc->addr, ttl) && p.length <= 1200) { send_on(m, ifc, &p, to); return; }
	if(airplay && !build(m, &p, 1, 0, host, ifc->addr, ttl)) send_on(m, ifc, &p, to);
	if(raop && !build(m, &p, 0, 1, host, ifc->addr, ttl)) send_on(m, ifc, &p, to);
	if(host && !airplay && !raop && !build(m, &p, 0, 0, 1, ifc->addr, ttl)) send_on(m, ifc, &p, to);
}

/* ---- which interfaces ---- */
static int private_v4(uint32_t a)
{
	uint32_t h = ntohl(a);
	return (h >> 24) == 10 || (h >> 20) == ((172u << 4) | 1) || (h >> 16) == ((192u << 8) | 168);
}
static int allowed(const char *name, uint32_t addr)
{
	const char *list = getenv("IDA_MDNS_IFACES");
	if(list && *list)
	{
		size_t n = strlen(name);
		for(const char *s = list; *s; )
		{
			const char *e = strchr(s, ',');
			size_t len = e ? (size_t)(e - s) : strlen(s);
			if(len == n && !strncmp(s, name, n)) return 1;
			if(!e) break;
			s = e + 1;
		}
		return 0;
	}
	const char *all = getenv("IDA_MDNS_ALL");
	if(all && *all == '1') return 1;
	return private_v4(addr);
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
		if(!a->ifa_addr || a->ifa_addr->sa_family != AF_INET || !(a->ifa_flags & IFF_UP) ||
			!(a->ifa_flags & IFF_MULTICAST) || (a->ifa_flags & IFF_LOOPBACK)) continue;
		uint32_t addr = ((struct sockaddr_in *)a->ifa_addr)->sin_addr.s_addr;
		if(!allowed(a->ifa_name, addr)) continue;
		int index = (int)if_nametoindex(a->ifa_name), found = -1;
		for(int i = 0; i < m->n_ifaces; i++) if(m->ifaces[i].index == index) found = i;
		if(found >= 0)
		{
			m->ifaces[found].seen = 1;
			m->ifaces[found].addr = addr;
			continue;
		}
		if(m->n_ifaces >= MAX_IFACES) continue;
		struct ip_mreqn mr;
		memset(&mr, 0, sizeof(mr));
		inet_pton(AF_INET, MDNS_ADDR4, &mr.imr_multiaddr);
		mr.imr_ifindex = index;
		if(setsockopt(m->fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mr, sizeof(mr)) == -1 && errno != EADDRINUSE)
		{
			note("cannot listen on %s: %s", a->ifa_name, strerror(errno));
			continue;
		}
		iface_t *n = &m->ifaces[m->n_ifaces++];
		n->index = index; n->addr = addr; n->seen = 1;
		snprintf(n->name, sizeof(n->name), "%s", a->ifa_name);
		char ip[INET_ADDRSTRLEN];
		inet_ntop(AF_INET, &addr, ip, sizeof(ip));
		note("on %s (%s)", n->name, ip);
		respond(m, n, 1, 1, 1, MDNSD_TTL_SERVICE, NULL);
	}
	freeifaddrs(list);
	for(int i = 0; i < m->n_ifaces; )
	{
		if(m->ifaces[i].seen) { i++; continue; }
		note("%s gone%s", m->ifaces[i].name, "");
		m->ifaces[i] = m->ifaces[--m->n_ifaces];
	}
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

static void query(mdnsd_t *m, const iface_t *ifc, const unsigned char *b, size_t len, const struct sockaddr_in *from)
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
		if(same(name, m->host_name) && type_is(type, DNS_TYPE_A)) host = 1;
	}
	if(!airplay && !raop && !host) return;
	respond(m, ifc, airplay, raop, host, MDNSD_TTL_SERVICE, NULL);
	if(unicast || from->sin_port != htons(MDNS_PORT)) respond(m, ifc, airplay, raop, host, MDNSD_TTL_SERVICE, from);
}

static void *loop(void *arg)
{
	mdnsd_t *m = arg;
	for(;;)
	{
		pthread_mutex_lock(&m->mutex);
		int fd = m->fd, run = m->running;
		if(run && time(NULL) - m->scanned >= SCAN_SECONDS) scan(m);
		pthread_mutex_unlock(&m->mutex);
		if(!run || fd < 0) break;

		fd_set rf;
		FD_ZERO(&rf);
		FD_SET(fd, &rf);
		struct timeval tv = { 0, 250000 };
		if(select(fd + 1, &rf, NULL, NULL, &tv) <= 0) continue;

		unsigned char buf[MDNS_MAX_PACKET], ctl[256];
		struct sockaddr_in from;
		struct iovec iov = { buf, sizeof(buf) };
		struct msghdr msg;
		memset(&msg, 0, sizeof(msg));
		msg.msg_name = &from; msg.msg_namelen = sizeof(from);
		msg.msg_iov = &iov; msg.msg_iovlen = 1;
		msg.msg_control = ctl; msg.msg_controllen = sizeof(ctl);
		ssize_t n = recvmsg(fd, &msg, 0);
		if(n <= 0) continue;
		int index = 0;
		for(struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
			if(c->cmsg_level == IPPROTO_IP && c->cmsg_type == IP_PKTINFO) index = ((struct in_pktinfo *)CMSG_DATA(c))->ipi_ifindex;
		pthread_mutex_lock(&m->mutex);
		for(int i = 0; i < m->n_ifaces; i++)
			if(m->ifaces[i].index == index) { iface_t ifc = m->ifaces[i]; query(m, &ifc, buf, (size_t)n, &from); break; }
		pthread_mutex_unlock(&m->mutex);
	}
	return NULL;
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
	m->fd = -1;
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
	if(m->running) { pthread_mutex_unlock(&m->mutex); return 0; }
	int fd = socket(AF_INET, SOCK_DGRAM, 0), one = 1;
	unsigned char ttl = 255, loopback = 1;
	if(fd < 0) { pthread_mutex_unlock(&m->mutex); return -errno; }
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
	if(bind(fd, (struct sockaddr *)&a, sizeof(a)) == -1)
	{
		int e = errno;
		close(fd);
		pthread_mutex_unlock(&m->mutex);
		return -e;
	}
	m->fd = fd;
	m->n_ifaces = 0;
	m->running = 1;
	scan(m);
	if(pthread_create(&m->thread, NULL, loop, m))
	{
		close(fd);
		m->fd = -1;
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
	if(!m->running) { pthread_mutex_unlock(&m->mutex); return; }
	m->running = 0;
	pthread_t t = m->thread;
	pthread_mutex_unlock(&m->mutex);
	pthread_join(t, NULL);
	pthread_mutex_lock(&m->mutex);
	if(m->fd >= 0) close(m->fd);
	m->fd = -1;
	m->n_ifaces = 0;
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_set_services(mdnsd_t *m, const mdnsd_service_t *airplay, const mdnsd_service_t *raop)
{
	if(!m) return;
	pthread_mutex_lock(&m->mutex);
	if(airplay) m->airplay = *airplay; else memset(&m->airplay, 0, sizeof(m->airplay));
	if(raop) m->raop = *raop; else memset(&m->raop, 0, sizeof(m->raop));
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_announce(mdnsd_t *m, uint32_t ttl)
{
	if(!m) return;
	pthread_mutex_lock(&m->mutex);
	for(int i = 0; i < m->n_ifaces; i++) respond(m, &m->ifaces[i], 1, 1, 1, ttl, NULL);
	pthread_mutex_unlock(&m->mutex);
}

void mdnsd_goodbye(mdnsd_t *m, const mdnsd_service_t *service)
{
	if(!m || !service || !service->registered) return;
	pthread_mutex_lock(&m->mutex);
	mdnsd_service_t keep_a = m->airplay, keep_r = m->raop;
	int is_airplay = !strcmp(service->type, keep_a.type);
	if(is_airplay) m->airplay = *service; else m->raop = *service;
	for(int i = 0; i < m->n_ifaces; i++) respond(m, &m->ifaces[i], is_airplay, !is_airplay, 0, 0, NULL);
	m->airplay = keep_a; m->raop = keep_r;
	pthread_mutex_unlock(&m->mutex);
}
