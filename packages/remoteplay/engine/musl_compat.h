/* SPDX-License-Identifier: AGPL-3.0-only
 * Remote Play Engine: glibc functions the library uses that musl doesn't have, declared for every file of the build
 * (build.sh passes -include musl_compat.h); defined in musl_compat.c. */
#ifndef IDA_RPE_MUSL_COMPAT_H
#define IDA_RPE_MUSL_COMPAT_H
#if defined(__linux__) && !defined(__GLIBC__)
#include <pthread.h>
#include <time.h>
int pthread_clockjoin_np(pthread_t thread, void **retval, clockid_t clock, const struct timespec *abstime);
#endif
#endif
