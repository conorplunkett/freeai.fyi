import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultBackend, ensureDevice } from "./backend.js";
import { locateRealClaude, readTerminalConfig } from "./claude.js";
import { startSessionMonitor } from "./monitor.js";
import { sessionDir } from "./paths.js";
import { buildFreeAiStatusLine, effectiveStatusLine, extractSettingsArg,
  readSettingsValue, writeSessionSettings } from "./settings.js";
import { initialState, updateState, writeState } from "./state.js";
import { removePath, safeHttpUrl, randomId } from "./util.js";

// Opt-in stderr tracing. The ad path is intentionally silent in normal use, so
// when "doctor" is green but no ad shows, `FREEAI_DEBUG=1 claude` reveals which
// step bailed (and whether the wrapper ran at all).
function debugEnabled(env) {
  return env?.FREEAI_DEBUG === "1" || env?.FREEAI_DEBUG === "true";
}
function debug(env, msg) {
  if (debugEnabled(env)) console.error(`freeai[debug]: ${msg}`);
}

export async function runClaude(argv, {
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  realClaudePath,
  cliPath = fileURLToPath(new URL("../bin/freeai.js", import.meta.url)),
  backend = defaultBackend({ home, env }),
  keepSession = false,
  monitorOptions = {},
} = {}) {
  const config = readTerminalConfig(home);
  const realClaude = locateRealClaude({
    explicit: realClaudePath,
    env,
    home,
    storedPath: config.realClaudePath,
  });
  if (!realClaude) {
    console.error("freeai: could not find the real claude executable; run `freeai claude setup`");
    return 127;
  }

  debug(env, `wrapper active; real claude: ${realClaude}`);
  const prepared = await prepareFreeAiSession({
    argv, cwd, env, home, realClaude, cliPath, backend, monitorOptions,
  }).catch((err) => {
    debug(env, `ad setup threw, running claude unchanged: ${err?.message || err}`);
    return null;
  });

  if (!prepared) {
    debug(env, "no ad session prepared; running claude unchanged");
    return spawnAndWait(realClaude, argv, { cwd, env });
  }

  const { finalArgv, cleanup, monitor, refreshTimer } = prepared;
  debug(env, `ad session ready via ${finalArgv[1]}`);
  try {
    return await spawnAndWait(realClaude, finalArgv, { cwd, env });
  } finally {
    monitor?.stop();
    if (refreshTimer) clearInterval(refreshTimer);
    if (!keepSession) cleanup();
  }
}

async function prepareFreeAiSession({
  argv, cwd, env, home, realClaude, cliPath, backend, monitorOptions,
}) {
  if (env.FREEAI_DISABLE === "1" || env.FREEAI_DISABLE === "true") {
    debug(env, "FREEAI_DISABLE set; skipping ads for this run");
    return null;
  }
  const config = await backend.config();
  if (config.serving === false) {
    debug(env, "backend reports serving=false; no ad this run");
    return null;
  }
  const ads = await backend.ads();
  const ad = ads[0];
  if (!ad) {
    debug(env, "backend returned no active ads");
    return null;
  }
  const device = await ensureDevice(home, backend);
  const trackingUrl = await backend.createClickIntent(device, ad.id);
  if (!safeHttpUrl(trackingUrl)) {
    debug(env, `click-intent returned no usable tracking URL (${trackingUrl})`);
    return null;
  }
  debug(env, `serving ad "${ad.line}" (${ad.id})`);

  const { cleanArgv, settingsValue } = extractSettingsArg(argv);
  let userSettings = {};
  if (settingsValue) userSettings = readSettingsValue(settingsValue, cwd);

  const previousStatusLine = effectiveStatusLine({ cwd, home, userSettings });
  const sessionId = randomId("cc");
  const dir = sessionDir(home, sessionId);
  const statePath = join(dir, "state.json");
  const settingsPath = join(dir, "settings.json");
  const prevPath = previousStatusLine ? join(dir, "prev-statusline.json") : "";
  const state = initialState({ sessionId, ad, trackingUrl });
  writeState(statePath, state);
  if (previousStatusLine) {
    writeFileSync(prevPath, JSON.stringify({ statusLine: previousStatusLine }, null, 2) + "\n", "utf8");
  }

  const statusLine = buildFreeAiStatusLine({
    cliPath, statePath, prevPath: prevPath || undefined,
  });
  const spinnerVerbs = await supportedSpinnerVerbs(realClaude)
    ? { mode: "replace", verbs: [ad.line] }
    : undefined;
  writeSessionSettings({ path: settingsPath, userSettings, statusLine, spinnerVerbs });

  const monitor = startSessionMonitor({
    statePath, home, backend, device, ad, ...monitorOptions,
  });
  const refreshTimer = setInterval(() => {
    void backend.createClickIntent(device, ad.id).then((nextUrl) => {
      if (!safeHttpUrl(nextUrl)) return;
      updateState(statePath, (next) => {
        next.trackingUrl = nextUrl;
        return next;
      });
    }).catch(() => {});
  }, 60_000);
  try { refreshTimer.unref?.(); } catch { /* ignore */ }

  return {
    finalArgv: ["--settings", settingsPath, ...cleanArgv],
    monitor,
    refreshTimer,
    cleanup: () => removePath(dir),
  };
}

export function spawnAndWait(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    const forward = (signal) => {
      try { child.kill(signal); } catch { /* ignore */ }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const onSighup = () => forward("SIGHUP");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);
    child.on("error", (err) => {
      console.error(`freeai: failed to run claude: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
      if (signal) resolve(128 + signalNumber(signal));
      else resolve(code ?? 0);
    });
  });
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] || 1;
}

async function supportedSpinnerVerbs(realClaude) {
  const version = await detectClaudeVersion(realClaude);
  if (!version) return false;
  return gte(version, [2, 1, 143]);
}

function detectClaudeVersion(realClaude) {
  return new Promise((resolve) => {
    try {
      execFile(realClaude, ["--version"], { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout || ""));
        resolve(match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
