#!/usr/bin/env python3
"""Generate the app-icon master and the dmg background as PNGs, no deps.

Run from anywhere; writes alongside this file:
  AppIcon-1024.png   - 1024x1024 master, downsampled to the .iconset by bundle.sh
  dmg-background.png  - 600x400 install-window backdrop with a drag arrow

The committed PNGs are the source of truth; this script only needs re-running if
the artwork changes.
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


def rounded_rect_contains(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def make_icon(size=1024):
    pixels = bytearray(size * size * 4)
    bg_top, bg_bot = (17, 21, 28), (10, 13, 18)      # dark squircle
    pill_l, pill_r = (45, 212, 191), (20, 184, 166)  # teal sponsor card
    margin = int(size * 0.08)
    radius = int(size * 0.225)
    # The sponsor "card": a rounded pill, echoing the real overlay.
    pw, ph = int(size * 0.56), int(size * 0.15)
    px0 = (size - pw) // 2
    py0 = (size - ph) // 2
    px1, py1 = px0 + pw, py0 + ph
    pill_r_corner = ph // 2
    # A small avatar dot at the pill's left, like a sponsor logo.
    dot_cx, dot_cy, dot_r = px0 + ph // 2, (py0 + py1) // 2, int(ph * 0.32)

    for y in range(size):
        t = y / (size - 1)
        base = lerp(bg_top, bg_bot, t)
        for x in range(size):
            i = (y * size + x) * 4
            if not rounded_rect_contains(x, y, margin, margin,
                                         size - margin, size - margin, radius):
                continue  # transparent outside the squircle
            r, g, b, a = base[0], base[1], base[2], 255
            if rounded_rect_contains(x, y, px0, py0, px1, py1, pill_r_corner):
                pt = (x - px0) / pw
                r, g, b = lerp(pill_l, pill_r, pt)
            if (x - dot_cx) ** 2 + (y - dot_cy) ** 2 <= dot_r * dot_r:
                r, g, b = (17, 21, 28)  # punch the dot out in dark
            pixels[i:i + 4] = bytes((r, g, b, a))
    write_png(os.path.join(HERE, "AppIcon-1024.png"), size, size, pixels)


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
    make_icon()
    make_dmg_background()
    print("wrote AppIcon-1024.png and dmg-background.png")
