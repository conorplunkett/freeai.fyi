#!/usr/bin/env python3
"""Generate the FreeAI app/extension icons — the "F$" coral wordmark — for every
surface, from a single definition. No third-party deps: it drives a local
Chromium (for real font rendering) and writes PNGs by hand.

The mark mirrors the shared brand renderer in
`vscode-extension/scripts/_brand.mjs` — the monospace "F$" (JetBrains Mono, the
same face as the site .logo chip and favicon) on the vertical coral gradient. The
gradient colors are read straight from the design-system source of truth,
`theme.css` (--accent-grad-a / --accent-grad-b), so the icon can never drift from
the palette. JetBrains Mono loads from Google Fonts when online; offline it falls
back to a local monospace (DejaVu Sans Mono) — the same monospaced shape.
`vscode-extension/scripts/gen-icon.mjs` remains the Marketplace-official path
(via Playwright); this tool is the dependency-free, offline one.

Writes (overwrites) every committed app icon:
  chrome-extension/icons/icon16.png, icon48.png, icon128.png
  vscode-extension/media/icon.png                       (256)
  desktop/macos/SponsorOverlay/packaging/assets/AppIcon-1024.png

Run:  make icons   (or:  python3 tools/gen-icons.py)
Set FREEAI_CHROME to point at a Chrome/Chromium binary if autodetection fails.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Layout — the mark is the monospace "F$" used by the site logo (.logo, which is
# var(--mono) = JetBrains Mono, weight 700) and the favicon. Offline, JetBrains
# Mono can't load, so we fall back to a local monospace — same monospaced shape.
RADIUS_RATIO = 0.26   # matches the site logo chip (8/30) and favicon (rx 26/100)
FONT_RATIO = 0.47
FONT_STACK = "'JetBrains Mono','DejaVu Sans Mono','Liberation Mono',ui-monospace,monospace"
PAD = 40  # transparent margin so the mark never touches the (height-capped) window

TARGETS = [
    ("chrome-extension/icons/icon16.png", 16),
    ("chrome-extension/icons/icon48.png", 48),
    ("chrome-extension/icons/icon128.png", 128),
    ("vscode-extension/media/icon.png", 256),
    ("desktop/macos/SponsorOverlay/packaging/assets/AppIcon-1024.png", 1024),
]


def read_gradient():
    """Pull --accent-grad-a / -b from theme.css (the palette source of truth)."""
    css = open(os.path.join(ROOT, "theme.css")).read()

    def tok(name, default):
        m = re.search(r"--%s:\s*(#[0-9a-fA-F]{6})" % name, css)
        return m.group(1) if m else default

    return tok("accent-grad-a", "#e08a6a"), tok("accent-grad-b", "#cf6b4a")


def find_chrome():
    for c in [os.environ.get("FREEAI_CHROME"),
              "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]:
        if c and os.path.exists(c):
            return c
    for name in ("google-chrome", "google-chrome-stable", "chromium",
                 "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    sys.exit("No Chrome/Chromium found. Set FREEAI_CHROME=/path/to/chrome.")


def icon_html(size, grad_top, grad_bot):
    r = round(size * RADIUS_RATIO)
    fs = round(size * FONT_RATIO)
    # Center the glyph with an SVG <text dominant-baseline="central"> (same as
    # _brand.mjs markSVG / the favicon) — flex + line-height:1 sits it too high.
    return (
        "<!doctype html><html><head><meta charset=utf-8>"
        "<link rel=preconnect href='https://fonts.googleapis.com'>"
        "<link href='https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap' rel=stylesheet>"
        "<style>html,body{margin:0;padding:0;background:transparent}"
        f"svg{{position:absolute;left:{PAD}px;top:{PAD}px}}</style></head><body>"
        f"<svg width={size} height={size} viewBox='0 0 {size} {size}' xmlns='http://www.w3.org/2000/svg'>"
        "<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>"
        f"<stop offset='0' stop-color='{grad_top}'/><stop offset='1' stop-color='{grad_bot}'/>"
        "</linearGradient></defs>"
        f"<rect width='{size}' height='{size}' rx='{r}' fill='url(#g)'/>"
        f"<text x='{size / 2}' y='{size / 2}' text-anchor='middle' dominant-baseline='central' "
        f"font-family=\"{FONT_STACK}\" font-weight='700' font-size='{fs}' letter-spacing='0' "
        "fill='#fff'>F$</text></svg></body></html>"
    )


# --- minimal PNG read (RGBA) / write ---------------------------------------
def _unfilter(raw, W, H):
    stride = W * 4
    prev = bytes(stride)
    pos = 0
    rows = []
    for _ in range(H):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if f == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                b = prev[x]; c = prev[x - 4] if x >= 4 else 0
                p = a + b - c; pa = abs(p - a); pb = abs(p - b); pc = abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        prev = bytes(line); rows.append(line)
    return rows


def read_rgba(path):
    d = open(path, "rb").read()
    i = 8; W = H = ct = 0; idat = b""
    while i < len(d):
        ln = struct.unpack(">I", d[i:i + 4])[0]; t = d[i + 4:i + 8]
        if t == b"IHDR":
            W, H, _bd, ct = struct.unpack(">IIBB", d[i + 8:i + 18])
        elif t == b"IDAT":
            idat += d[i + 8:i + 8 + ln]
        elif t == b"IEND":
            break
        i += 12 + ln
    assert ct == 6, "expected RGBA screenshot"
    return W, H, _unfilter(zlib.decompress(idat), W, H)


def write_rgba(path, W, H, rows):
    raw = bytearray()
    for r in rows:
        raw.append(0); raw += r

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def render(chrome, out_path, size, grad):
    win_w = size + 2 * PAD
    win_h = (size + 2 * PAD) * 2  # height is capped by headless; give it room
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "m.html")
        shot = os.path.join(tmp, "m.png")
        open(html, "w").write(icon_html(size, *grad))
        subprocess.run(
            [chrome, "--headless", "--no-sandbox", "--disable-gpu",
             "--hide-scrollbars", "--force-device-scale-factor=1",
             "--virtual-time-budget=4000",
             f"--window-size={win_w},{win_h}",
             "--default-background-color=00000000",
             f"--screenshot={shot}", "file://" + html],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        _W, _H, rows = read_rgba(shot)
        crop = []
        for y in range(PAD, PAD + size):
            src = rows[y]
            crop.append(src[PAD * 4:(PAD + size) * 4])
        write_rgba(os.path.join(ROOT, out_path), size, size, crop)
        print(f"  {out_path}  ({size}x{size})")


def main():
    chrome = find_chrome()
    grad = read_gradient()
    print(f"F$ coral mark  gradient {grad[0]}→{grad[1]}  via {chrome}")
    for path, size in TARGETS:
        render(chrome, path, size, grad)
    print("done")


if __name__ == "__main__":
    main()
