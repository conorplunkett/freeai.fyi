import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "./util.js";

export const DEFAULT_API_BASE =
  "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api";

export function freeAiDir(home = homedir()) {
  return join(home, ".freeai");
}

export function claudeFreeAiDir(home = homedir()) {
  return join(freeAiDir(home), "claude");
}

export function terminalConfigPath(home = homedir()) {
  return join(claudeFreeAiDir(home), "config.json");
}

export function devicePath(home = homedir()) {
  return join(freeAiDir(home), "device.json");
}

export function sessionsDir(home = homedir()) {
  return join(claudeFreeAiDir(home), "sessions");
}

export function sessionDir(home, sessionId) {
  return join(sessionsDir(home), sessionId);
}

export function userFreeAiConfigPath(home = homedir()) {
  return join(freeAiDir(home), "config.json");
}

export function resolveApiBase({ home = homedir(), env = process.env } = {}) {
  const cfg = readJson(userFreeAiConfigPath(home), {});
  const configured = typeof cfg?.backendBaseUrl === "string"
    ? cfg.backendBaseUrl.trim()
    : "";
  const fromEnv = typeof env.FREEAI_BASE === "string" ? env.FREEAI_BASE.trim() : "";
  return (configured || fromEnv || DEFAULT_API_BASE).replace(/\/+$/, "");
}
