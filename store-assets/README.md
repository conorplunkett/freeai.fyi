# Chrome Web Store listing assets

Exact-sized and ready to upload to the Chrome Web Store developer dashboard —
no resizing needed on your end. Regenerate any time with `make store-assets`.

| File | Dimensions | Format | Dashboard slot |
|---|---|---|---|
| `store-icon-128x128.png` | 128×128 | PNG (transparency OK) | Store icon |
| `screenshot-1-light-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots — light chat |
| `screenshot-2-dark-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots — dark chat |
| `screenshot-3-hero-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots — homepage hero |
| `screenshot-4-install-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots — install / CTA |
| `marquee-1400x560.png` | 1400×560 | 24-bit PNG, no alpha | Marquee promo tile |
| `promo-small-440x280.png` | 440×280 | 24-bit PNG, no alpha | Small promo tile |

The **"no alpha" 24-bit** format is what avoids the dashboard's *"image size is
incorrect"* rejection. Screenshots are **downscaled only (never upscaled)**;
where a source doesn't fill the frame it's padded with a matching white/dark
border instead of being stretched.

## Regenerate

    make store-assets        # or: node tools/gen-store-assets.mjs

`tools/gen-store-assets.mjs` drives the repo's Playwright Chromium, serves the
site from a throwaway static server, and:

- captures the **live product** — the hero *Stock Claude → With FreeAI*
  before/after demo, the homepage hero viewport, and the install / CTA card — so
  the screenshots are the real extension, not mockups;
- composes the **marquee** + **small promo tile** on the brand background, with
  the palette read straight from `theme.css` (same rule as `tools/gen-og.mjs` —
  never hardcode a color);
- hands every output to `tools/png_fit.py`, which pads/flattens to the exact
  pixel size as a 24-bit PNG with no alpha.

Source images for the two chat screenshots live in `screenshots/`; the store
icon is downscaled from the macOS `AppIcon-1024.png`.

## Still optional
- The two mobile referral panels combined into one 1280×800 screenshot (source
  files not yet in the repo).
