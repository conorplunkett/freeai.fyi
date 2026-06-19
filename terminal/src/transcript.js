import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const IDLE_STALE_MS = 90_000;

export function transcriptEntrypoint(path) {
  try {
    const fd = openSync(path, "r");
    let text;
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.entrypoint === "string") return row.entrypoint;
      } catch { /* ignore sliced or non-json rows */ }
    }
    return null;
  } catch {
    return null;
  }
}

export function scanTranscripts(home = homedir()) {
  const root = join(home, ".claude", "projects");
  const out = [];
  try {
    if (!existsSync(root)) return out;
    for (const project of readdirSync(root)) {
      const dir = join(root, project);
      let files;
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dir, file);
        try { out.push({ path, mtimeMs: statSync(path).mtimeMs }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function locateClaudeCliTranscript(home = homedir()) {
  const candidates = scanTranscripts(home).slice(0, 20);
  let newestUntagged = "";
  for (const candidate of candidates) {
    const tag = transcriptEntrypoint(candidate.path);
    if (tag === "cli") return candidate.path;
    if (tag === null && !newestUntagged) newestUntagged = candidate.path;
  }
  return newestUntagged;
}

export function readTranscriptActivity(path, now = Date.now()) {
  try {
    if (!path || !existsSync(path)) return null;
    const st = statSync(path);
    const size = st.size;
    if (size <= 0) return null;
    const want = Math.min(size, 128 * 1024);
    const fd = openSync(path, "r");
    let text;
    try {
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = text.split("\n");
    if (want < size) lines.shift();
    let done = null;
    let pendingUserAfterAssistant = false;
    let tool = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const msg = row.message;
      if (done === null && row.type === "user") {
        pendingUserAfterAssistant = true;
        continue;
      }
      if (row.type === "assistant" && msg && typeof msg === "object") {
        if (done === null) {
          if (pendingUserAfterAssistant) {
            done = false;
          } else {
            const stopReason = msg.stop_reason;
            done = !!stopReason && stopReason !== "tool_use";
          }
        }
        if (!tool && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "tool_use" && typeof block.name === "string") {
              tool = block.name;
              break;
            }
          }
        }
      }
      if (done !== null && tool) break;
    }
    if (done === null && pendingUserAfterAssistant) done = false;
    const ageMs = Math.max(0, now - st.mtimeMs);
    const isDone = done === true || ageMs > IDLE_STALE_MS;
    return { active: !isDone, done: isDone, tool, ageMs, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
