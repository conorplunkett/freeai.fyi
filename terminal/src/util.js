import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function stripControlChars(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function removePath(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function randomId(prefix = "") {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID();
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
