#!/usr/bin/env python3
"""Generate the dmg install-window background as a PNG, no deps.

Run from anywhere; writes alongside this file:
  dmg-background.png  - 600x400 install-window backdrop with a drag arrow

The app-icon master (AppIcon-1024.png, downsampled to the .iconset by bundle.sh)
is the shared FreeAI "F$" coral wordmark — regenerate it with `make icons`
(tools/gen-icons.py), which renders the same mark for every surface. The
committed PNGs are the source of truth.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def write_png(path, width, height, pixels):
    """pixels: bytearray of RGBA, length width*height*4."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def make_dmg_background(w=600, h=400):
    pixels = bytearray(w * h * 4)
    top, bot = (247, 248, 250), (236, 238, 242)
    arrow = (188, 194, 204)
    # Arrow sits between the app icon (~x165) and Applications (~x435) at y~175.
    ay = 175
    shaft_x0, shaft_x1 = 250, 338
    head_x1 = 368
    for y in range(h):
        row = lerp(top, bot, y / (h - 1))
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b = row
            in_shaft = shaft_x0 <= x <= shaft_x1 and ay - 8 <= y <= ay + 8
            half = max(0, head_x1 - x)  # triangle narrows toward the tip
            in_head = shaft_x1 <= x <= head_x1 and abs(y - ay) <= half
            if in_shaft or in_head:
                r, g, b = arrow
            pixels[i:i + 4] = bytes((r, g, b, 255))
    write_png(os.path.join(HERE, "dmg-background.png"), w, h, pixels)


if __name__ == "__main__":
    make_dmg_background()
    print("wrote dmg-background.png")
