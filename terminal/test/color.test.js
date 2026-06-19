import test from "node:test";
import assert from "node:assert/strict";
import { brandColor, hexToRgb, normalizeHex, resolveAdColor, shimmer } from "../src/color.js";
import { composeAdText } from "../src/util.js";

test("normalizeHex accepts #rrggbb and bare rrggbb, rejects junk", () => {
  assert.equal(normalizeHex("#5B5BD6"), "#5b5bd6");
  assert.equal(normalizeHex("5b5bd6"), "#5b5bd6");
  assert.equal(normalizeHex("blue"), "");
  assert.equal(normalizeHex("#fff"), "");
  assert.equal(normalizeHex(null), "");
});

test("hexToRgb parses valid hex and rejects invalid", () => {
  assert.deepEqual(hexToRgb("#5b5bd6"), { r: 91, g: 91, b: 214 });
  assert.equal(hexToRgb("nope"), null);
});

test("brandColor is deterministic per seed and in range", () => {
  const a = brandColor("Linear");
  const b = brandColor("Linear");
  assert.deepEqual(a, b);
  assert.notDeepEqual(brandColor("Linear"), brandColor("Ramp"));
  for (const c of [a.r, a.g, a.b]) {
    assert.ok(c >= 0 && c <= 255);
  }
});

test("resolveAdColor prefers advertiser color, falls back to brand color", () => {
  assert.deepEqual(resolveAdColor({ color: "#5b5bd6", seed: "Linear" }), { r: 91, g: 91, b: 214 });
  assert.deepEqual(resolveAdColor({ color: "", seed: "Linear" }), brandColor("Linear"));
  assert.deepEqual(resolveAdColor({ color: "garbage", seed: "Linear" }), brandColor("Linear"));
});

test("shimmer emits a truecolor base and advances with time", () => {
  const rgb = { r: 91, g: 91, b: 214 };
  const a = shimmer("Plan your next sprint faster", rgb, { now: 0 });
  const b = shimmer("Plan your next sprint faster", rgb, { now: 2000 });
  assert.match(a, /\[38;2;91;91;214m/); // base color present
  assert.match(a, /\[1m/);              // bold
  assert.notEqual(a, b);                       // sweep position changed over time
  assert.equal(shimmer("", rgb), "");
});

test("composeAdText joins brand and slogan but avoids duplicating the brand", () => {
  assert.equal(composeAdText("Linear", "Plan your next sprint faster"), "Linear — Plan your next sprint faster");
  assert.equal(composeAdText("Linear", "Linear — issue tracking"), "Linear — issue tracking");
  assert.equal(composeAdText("", "Just a line"), "Just a line");
  assert.equal(composeAdText("Brand", ""), "Brand");
});
