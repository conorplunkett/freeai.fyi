# Chrome Web Store listing assets

Exact-sized and ready to upload to the Chrome Web Store developer dashboard —
no resizing needed on your end.

| File | Dimensions | Format | Dashboard slot |
|---|---|---|---|
| `store-icon-128x128.png` | 128×128 | PNG (transparency OK) | Store icon |
| `screenshot-1-light-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots |
| `screenshot-2-dark-1280x800.png` | 1280×800 | 24-bit PNG, no alpha | Screenshots |
| `marquee-1400x560.png` | 1400×560 | 24-bit PNG, no alpha | Marquee promo tile |

Screenshots are **downscaled only (never upscaled)** and padded with a matching
white/dark border to hit exact dimensions without distortion. The "no alpha"
24-bit format is what avoids the dashboard's "image size is incorrect" rejection.

The **marquee** is generated from the live product: the hero "Stock Claude →
With FreeAI" before/after demo is captured headless (Playwright Chromium), then
composed on the brand background with the palette read straight from `theme.css`
(same approach as `tools/gen-og.mjs`), and exported at exactly 1400×560.

## Still to add (optional)
- Small promo tile (440×280).
- The two mobile referral panels combined into one 1280×800 screenshot (source
  files not yet in the repo).
