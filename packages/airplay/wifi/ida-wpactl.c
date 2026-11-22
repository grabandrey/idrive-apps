/*
 * AirPlay Wi-Fi: ida-wpactl, one request to a wpa_supplicant or hostapd control socket (the protocol wpa_cli and
 * hostapd_cli speak: a datagram with the command, a datagram back), for head units without those tools.
 *
 *   ida-wpactl <control socket> <command words...>     prints the reply; exit 1 when there is none
 *
 * Built by build_wpactl.sh: static (musl), for x86_64 and aarch64. MIT licensed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if(argc < 3) { fprintf(stderr, "usage: ida-wpactl <control socket> <command...>\n"); return 64; }
	char cmd[4096] = "";
	for(int i = 2; i < argc; i++)
	{
		if(strlen(cmd) + strlen(argv[i]) + 2 > sizeof(cmd)) { fprintf(stderr, "too long\n"); return 64; }
		if(i > 2) strcat(cmd, " ");
		strcat(cmd, argv[i]);
	}
	int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	struct sockaddr_un me, to;
	memset(&me, 0, sizeof(me));
	me.sun_family = AF_UNIX;
	/* our own address, so the reply can come back */
	snprintf(me.sun_path, sizeof(me.sun_path), "/tmp/ida-wpactl-%d", (int)getpid());
	unlink(me.sun_path);
	if(fd < 0 || bind(fd, (struct sockaddr *)&me, sizeof(me)) < 0) { printf("ERROR: socket: %s\n", strerror(errno)); return 1; }
	memset(&to, 0, sizeof(to));
	to.sun_family = AF_UNIX;
	snprintf(to.sun_path, sizeof(to.sun_path), "%s", argv[1]);
	int code = 1;
	if(connect(fd, (struct sockaddr *)&to, sizeof(to)) < 0 || send(fd, cmd, strlen(cmd), 0) < 0)
		printf("ERROR: %s: %s\n", argv[1], strerror(errno));
	else
	{
		static char buf[65536];
		/* unsolicited event messages ("<3>CTRL-EVENT-...") may come first: skipped */
		for(int tries = 0; tries < 20; tries++)
		{
			struct pollfd p = { fd, POLLIN, 0 };
			if(poll(&p, 1, 10000) <= 0) { printf("ERROR: no reply\n"); break; }
			ssize_t n = recv(fd, buf, sizeof(buf) - 1, 0);
			if(n < 0) { printf("ERROR: %s\n", strerror(errno)); break; }
			buf[n] = 0;
			if(n > 0 && buf[0] == '<') continue;
			fwrite(buf, 1, (size_t)n, stdout);
			if(n && buf[n - 1] != '\n') putchar('\n');
			code = 0;
			break;
		}
	}
	close(fd);
	unlink(me.sun_path);
	return code;
}
