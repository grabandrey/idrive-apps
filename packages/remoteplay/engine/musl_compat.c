/* SPDX-License-Identifier: AGPL-3.0-only
 * Remote Play Engine: pthread_clockjoin_np (glibc 2.31) on musl, through musl's pthread_timedjoin_np, which takes a
 * CLOCK_REALTIME deadline: the time left on the asked clock is added to the real time now. */
#define _GNU_SOURCE
#include "musl_compat.h"
#if defined(__linux__) && !defined(__GLIBC__)
#include <errno.h>

int pthread_timedjoin_np(pthread_t thread, void **retval, const struct timespec *abstime);

int pthread_clockjoin_np(pthread_t thread, void **retval, clockid_t clock, const struct timespec *abstime)
{
	if(!abstime)
		return pthread_join(thread, retval);
	if(clock == CLOCK_REALTIME)
		return pthread_timedjoin_np(thread, retval, abstime);
	struct timespec now, real, deadline;
	clock_gettime(clock, &now);
	clock_gettime(CLOCK_REALTIME, &real);
	long long left = (long long)(abstime->tv_sec - now.tv_sec) * 1000000000LL + (abstime->tv_nsec - now.tv_nsec);
	if(left < 0)
		left = 0;
	long long ns = real.tv_nsec + left % 1000000000LL;
	deadline.tv_sec = real.tv_sec + (time_t)(left / 1000000000LL) + (time_t)(ns / 1000000000LL);
	deadline.tv_nsec = (long)(ns % 1000000000LL);
	return pthread_timedjoin_np(thread, retval, &deadline);
}
#endif
