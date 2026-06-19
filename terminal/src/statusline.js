import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readTranscriptActivity } from "./transcript.js";
import { readState, updateState } from "./state.js";
import { safeHttpUrl, stripControlChars } from "./util.js";

const ACTIVE_STALE_MS = 4000;
const PREV_TIMEOUT_MS = 1500;

export async function runStatusLine({
  statePath,
  prevPath,
  stdin = process.stdin,
  stdout = process.stdout,
  now = Date.now(),
} = {}) {
  try {
    const input = await readAllStdin(stdin);
    const parsed = parseMaybeJson(input);
    const transcriptPath = extractTranscriptPath(parsed);
    updateState(statePath, (state) => {
      state.lastHeartbeatMs = now;
      state.lastStatusLineMs = now;
      if (transcriptPath) state.transcriptPath = transcriptPath;
      return state;
    });

    const state = readState(statePath) || {};
    const activity = transcriptPath || state.transcriptPath
      ? readTranscriptActivity(transcriptPath || state.transcriptPath, now)
      : null;
    const transcriptActive = activity
      ? activity.active && activity.ageMs <= ACTIVE_STALE_MS
      : false;
    const active = transcriptActive || state.active === true;
    if (transcriptActive && !state.active) {
      updateState(statePath, (next) => {
        next.active = true;
        next.lastActiveMs = now;
        if (!next.activeStartedAt) next.activeStartedAt = now;
        return next;
      });
    }

    const lines = [];
    const adLine = active ? buildAdLine(state) : "";
    if (adLine) lines.push(adLine);
    const prev = prevPath ? await runPreviousStatusLine(prevPath, input) : "";
    if (prev) lines.push(prev);
    if (lines.length) stdout.write(lines.join("\n"));
  } catch {
    // Status line commands must never disturb Claude Code.
  }
}

export function buildAdLine(state) {
  const line = stripControlChars(state?.ad?.line || "");
  const url = safeHttpUrl(state?.trackingUrl || "");
  if (!line) return "";
  const text = `ad\u00b7 ${line}`;
  if (!url) return text;
  const esc = "\u001b";
  return `${esc}]8;;${url}${esc}\\${text}${esc}]8;;${esc}\\`;
}

async function runPreviousStatusLine(prevPath, input) {
  let prev;
  try {
    prev = JSON.parse(readFileSync(prevPath, "utf8")).statusLine;
  } catch {
    return "";
  }
  if (!prev || prev.type !== "command" || typeof prev.command !== "string") return "";
  if (prev.command.includes("freeai claude statusline")) return "";
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(out.replace(/[\r\n]+$/, ""));
    };
    let child;
    try {
      child = spawn(prev.command, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return resolve("");
    }
    child.stdout.on("data", (chunk) => {
      if (out.length < 16 * 1024) out += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("close", finish);
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish();
    }, PREV_TIMEOUT_MS);
    try {
      child.stdin.end(input || "");
    } catch {
      finish();
    }
  });
}

function parseMaybeJson(value) {
  try {
    if (!value) return {};
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function extractTranscriptPath(input) {
  if (!input || typeof input !== "object") return "";
  return String(input.transcript_path || input.transcriptPath
    || input.transcript?.path || "");
}

async function readAllStdin(stdin) {
  if (!stdin || stdin.isTTY) return "";
  let out = "";
  for await (const chunk of stdin) {
    out += chunk.toString("utf8");
    if (out.length > 64 * 1024) break;
  }
  return out;
}
