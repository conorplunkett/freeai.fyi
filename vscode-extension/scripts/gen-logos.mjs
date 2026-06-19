// Generates the full FreeAI logo asset set in extension/media/logos/.
// The mark is the "F$" wordmark (JetBrains Mono, white) on a vertical coral
// gradient rounded square. Raster sizes are produced with headless Chromium
// (real typeface — see _brand.mjs); SVG variants are font-based.
// Run: `node extension/scripts/gen-logos.mjs`.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderAssets, markSVG, toICO, GREEN } from "./_brand.mjs";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "logos");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const { icons, lockup } = await renderAssets({ sizes, lockupHeight: 120 });

const bySize = new Map();
for (const size of sizes) {
  const png = icons.get(size);
  const name = `freeai-${size}.png`;
  writeFileSync(join(outDir, name), png);
  bySize.set(size, png);
  console.log(`  ${name} (${png.length} bytes)`);
}

// favicon.ico (16, 32, 48)
const ico = toICO([16, 32, 48].map((size) => ({ size, png: bySize.get(size) })));
writeFileSync(join(outDir, "favicon.ico"), ico);
console.log(`  favicon.ico (${ico.length} bytes, 3 sizes)`);

// Derived web/social names
writeFileSync(join(outDir, "favicon-32.png"), bySize.get(32));
writeFileSync(join(outDir, "apple-touch-icon.png"), bySize.get(180));
writeFileSync(join(outDir, "og-logo.png"), bySize.get(512));
writeFileSync(join(outDir, "icon-192.png"), bySize.get(192));
writeFileSync(join(outDir, "icon-512.png"), bySize.get(512));
console.log("  favicon-32 / apple-touch-icon / og-logo / icon-192 / icon-512");

// Horizontal lockup (mark + "FreeAI.ai") for README / docs
writeFileSync(join(outDir, "freeai-lockup.png"), lockup);
console.log(`  freeai-lockup.png (${lockup.length} bytes)`);

// SVG variants
writeFileSync(join(outDir, "freeai.svg"), markSVG({ box: true, fill: "#fff" }));
writeFileSync(join(outDir, "favicon.svg"), markSVG({ box: true, fill: "#fff" }));
writeFileSync(join(outDir, "freeai-white.svg"), markSVG({ box: false, fill: "#fff" }));
writeFileSync(join(outDir, "freeai-green.svg"), markSVG({ box: false, fill: GREEN }));
console.log("  freeai.svg / favicon.svg / freeai-white.svg / freeai-green.svg");

console.log(`\nDone! All assets in: ${outDir}`);
