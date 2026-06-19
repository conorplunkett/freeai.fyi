import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { ensureDir, isPlainObject, shQuote } from "./util.js";

export function extractSettingsArg(argv) {
  const cleanArgv = [];
  let settingsValue = null;
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      cleanArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      cleanArgv.push(arg);
      continue;
    }
    if (arg === "--settings") {
      settingsValue = argv[i + 1] ?? "";
      i++;
      continue;
    }
    if (arg.startsWith("--settings=")) {
      settingsValue = arg.slice("--settings=".length);
      continue;
    }
    cleanArgv.push(arg);
  }
  return { cleanArgv, settingsValue };
}

export function readSettingsValue(value, cwd = process.cwd()) {
  if (!value) return {};
  const trimmed = String(value).trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return parseJsonc(trimmed);
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  return parseJsonc(readFileSync(path, "utf8"));
}

export function readSettingsFile(path) {
  try {
    if (!path || !existsSync(path)) return {};
    return parseJsonc(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function candidateSettingsPaths({ cwd = process.cwd(), home = homedir() } = {}) {
  return [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
}

export function effectiveStatusLine({ cwd = process.cwd(), home = homedir(), userSettings = null } = {}) {
  let statusLine;
  for (const path of candidateSettingsPaths({ cwd, home })) {
    const settings = readSettingsFile(path);
    if (settings && Object.prototype.hasOwnProperty.call(settings, "statusLine")) {
      statusLine = settings.statusLine;
    }
  }
  if (userSettings && Object.prototype.hasOwnProperty.call(userSettings, "statusLine")) {
    statusLine = userSettings.statusLine;
  }
  return isForeignStatusLine(statusLine) ? statusLine : undefined;
}

export function isForeignStatusLine(value) {
  return isPlainObject(value)
    && value.type === "command"
    && typeof value.command === "string"
    && !value.command.includes("freeai-statusline")
    && !value.command.includes("freeai claude statusline");
}

export function statusLineCommand({ nodePath = process.execPath, cliPath, statePath, prevPath }) {
  const parts = [
    shQuote(nodePath),
    shQuote(cliPath),
    "claude",
    "statusline",
    "--state",
    shQuote(statePath),
  ];
  if (prevPath) parts.push("--prev", shQuote(prevPath));
  return parts.join(" ");
}

export function buildFreeAiStatusLine(params) {
  return {
    type: "command",
    command: statusLineCommand(params),
    padding: 0,
  };
}

export function writeSessionSettings({ path, userSettings = {}, statusLine, spinnerVerbs }) {
  const out = isPlainObject(userSettings) ? { ...userSettings } : {};
  out.statusLine = statusLine;
  if (spinnerVerbs) out.spinnerVerbs = spinnerVerbs;
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}
