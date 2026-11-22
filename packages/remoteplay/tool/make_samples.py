#!/usr/bin/env python3
"""Remote Play Video: writes samples/, the short clips the tool decodes to check each decoder really works and to run
the video test without an encoder on the head unit. An original synthetic picture (a moving gradient and a bouncing
square), encoded as a console streams: Annex B, no B-frames.

    pip install av numpy; python3 packages/remoteplay/tool/make_samples.py
"""
import os
import av
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def frame(i, w, h):
    y, x = np.mgrid[0:h, 0:w]
    img = np.zeros((h, w, 3), np.uint8)
    img[..., 0] = (x * 255 // w + i * 3) % 256
    img[..., 1] = (y * 255 // h + i * 2) % 256
    img[..., 2] = 96
    s = h // 5
    bx = int((w - s) * (0.5 + 0.5 * np.sin(i / 17.0)))
    by = int((h - s) * (0.5 + 0.5 * np.cos(i / 11.0)))
    img[by:by + s, bx:bx + s] = (240, 240, 240)
    return img


def write(name, codec, w, h, fps, frames, opts):
    path = os.path.join(HERE, 'samples', name)
    out = av.open(path, 'w', format='h264' if codec == 'libx264' else 'hevc')
    st = out.add_stream(codec, rate=fps)
    st.width, st.height, st.pix_fmt = w, h, 'yuv420p'
    st.options = opts
    for i in range(frames):
        for p in st.encode(av.VideoFrame.from_ndarray(frame(i, w, h), format='rgb24')):
            out.mux(p)
    for p in st.encode():
        out.mux(p)
    out.close()
    print(name, os.path.getsize(path), 'bytes')


os.makedirs(os.path.join(HERE, 'samples'), exist_ok=True)
X264 = {'profile': 'main', 'bf': '0', 'crf': '32', 'preset': 'medium', 'g': '60'}
write('check.h264', 'libx264', 640, 360, 30, 30, X264)
write('check.h265', 'libx265', 640, 360, 30, 30, {'crf': '32', 'x265-params': 'bframes=0:log-level=error'})
write('test720p60.h264', 'libx264', 1280, 720, 60, 480, X264)
