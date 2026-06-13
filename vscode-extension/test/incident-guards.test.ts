/** W7 incident-class regressions.
 *
 *  Each test in this file encodes ONE past incident as a static check so
 *  the failure cannot return undetected.  Background: see memory entries
 *  for the spinner-icon widening, MutationObserver crash ("the CC crash"),
 *  and the version-baseline non-monotonic deploy bug. */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..");
const BLOCK_PATH = join(ROOT, "src", "adapters", "claude-code", "block.asset.js");
const ADAPTER_PATH = join(ROOT, "src", "adapters", "claude-code", "adapter.ts");
const PKG_PATH = join(ROOT, "package.json");

const block = readFileSync(BLOCK_PATH, "utf8");
const adapter = readFileSync(ADAPTER_PATH, "utf8");

describe("W7: spinner detection stays class-scoped (prime-directive)", () => {
  // The original incident: widening the glyph/icon set to include `·` or
  // `*` made the detector match Monaco editor + markdown content and the
  // injection clobbered the user's editor. Detection must stay scoped via
  // CC's `spinnerRow_` class prefix.
  it("findSpinner queries by [class*=\"spinnerRow_\"] only", () => {
    expect(block).toMatch(/querySelectorAll\(['"]\[class\*="spinnerRow_"\]['"]\)/);
  });

  it("rowActive() recognises only the documented sparkle glyphs (no ·, no *)", () => {
    // The four sparkle code points CC uses: ✢ U+2722, ✶ U+2736, ✻ U+273B, ✽ U+273D.
    expect(block).toMatch(/0x2722/);
    expect(block).toMatch(/0x2736/);
    expect(block).toMatch(/0x273b/);
    expect(block).toMatch(/0x273d/);
    // Common widening candidates that previously caused clobber regressions.
    // The string `·` (U+00B7) and `*` should never appear in a charCode
    // comparison branch. We allow them in comments/strings elsewhere; this
    // guard fires on the rowActive code shape specifically.
    const rowActiveBody = /function\s+rowActive[\s\S]+?return\s+c\s*===[\s\S]+?\}/m
      .exec(block)?.[0] ?? "";
    expect(rowActiveBody, "rowActive must stay glyph-narrow")
      .not.toMatch(/0x00b7/i);
    expect(rowActiveBody).not.toMatch(/0x002a/i);
  });
});

describe("W7: no whole-document MutationObserver (the CC crash)", () => {
  // Memory: a `{ childList:true, subtree:true }` observer attached at body
  // root and firing evaluate() per token caused main-thread saturation and
  // VS Code terminated the webview. The 80ms interval + rAF + watchdog
  // detects within 80ms with NO unbounded cost — do not reintroduce.
  it("does not call MutationObserver.observe with subtree:true on document/body", () => {
    // Look for any MutationObserver wiring; the block asset should have NONE
    // (the architectural decision is "polling-only").
    expect(block).not.toMatch(/new\s+MutationObserver/);
    // Belt-and-suspenders: even if a future change adds one, document or
    // document.body observation with subtree:true is the specific failure
    // mode and is banned.
    expect(block).not.toMatch(/\.observe\s*\(\s*document(\.body)?[^)]*subtree\s*:\s*true/);
  });
});

describe("W7: extension version monotonic baseline", () => {
  // Memory: a frozen committed version meant the deploy published a manifest
  // ≤ running, and self-update silently no-op'd. This guard catches a regress
  // by checking the committed semver is at least the documented baseline.
  // FreeAI starts its own version line at 0.1.0; the guard still protects
  // against an accidental downgrade below that fresh baseline.
  it("package.json version >= 0.1.0 (FreeAI line minimum)", () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string };
    const [maj, min, pat] = pkg.version.split(".").map((x) => parseInt(x, 10));
    expect(Number.isFinite(maj) && Number.isFinite(min) && Number.isFinite(pat))
      .toBe(true);
    const ord = maj * 1_000_000 + min * 1_000 + pat;
    const baseline = 0 * 1_000_000 + 1 * 1_000 + 0;
    expect(ord, `version ${pkg.version} below the 0.1.0 baseline`).toBeGreaterThanOrEqual(baseline);
  });
});

describe("W7: legacy backup suffixes still recognised (W1 + S3 backwards-compat)", () => {
  // The rename introduces .freeai-backup but pre-rename users have a
  // .freeai-backup file (FreeAI era) or the older .vibads-backup file
  // (pre-S3 era) on disk. The adapter must still recognise EVERY legacy
  // suffix or "Restore Claude Code" silently no-ops for those users.
  it("adapter source references .freeai-backup (current)", () => {
    expect(adapter).toMatch(/\.freeai-backup/);
  });
  it("adapter source references .freeai-backup (FreeAI era legacy)", () => {
    expect(adapter).toMatch(/\.freeai-backup/);
  });
  it("adapter source references .vibads-backup (pre-S3 era legacy)", () => {
    expect(adapter).toMatch(/\.vibads-backup/);
  });
});
