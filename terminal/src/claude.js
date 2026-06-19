import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { terminalConfigPath } from "./paths.js";
import { ensureDir, readJson, writeJsonAtomic } from "./util.js";

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name, env = process.env) {
  const path = env.PATH || "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate) && executable(candidate)) return candidate;
  }
  return null;
}

export function readTerminalConfig(home = homedir()) {
  return readJson(terminalConfigPath(home), {});
}

export function writeTerminalConfig(home, config) {
  ensureDir(dirname(terminalConfigPath(home)));
  writeJsonAtomic(terminalConfigPath(home), config);
}

export function locateRealClaude({
  explicit,
  env = process.env,
  home = homedir(),
  storedPath,
} = {}) {
  const configured = explicit || env.FREEAI_CLAUDE_REAL || storedPath
    || readTerminalConfig(home).realClaudePath;
  if (configured && existsSync(configured) && executable(configured)) {
    return configured;
  }
  return findExecutable("claude", env);
}
