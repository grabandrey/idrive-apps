// SPDX-License-Identifier: GPL-3.0-or-later
/* AirPlay Engine: the picture decoded here, for head units without GStreamer (soft_video.c) */
#ifndef SOFT_VIDEO_H
#define SOFT_VIDEO_H

int sv_start(const char *run_dir);                          /* <run>/frames.sock for the app */
void sv_feed(const unsigned char *data, int len, int h265); /* Annex B, as the phone sends it */
void sv_reset(void);                                         /* a new stream: a fresh decoder */
void sv_stats(unsigned long *decoded, unsigned long *sent, int *app);

#endif
