import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { installShellBlock, restoreShellBlock, shellFromEnv, defaultRcPath } from "./shell.js";
import { locateRealClaude, readTerminalConfig, writeTerminalConfig } from "./claude.js";
import { runClaude } from "./run.js";
import { runStatusLine } from "./statusline.js";
import { terminalConfigPath, resolveApiBase } from "./paths.js";
import { defaultBackend, ensureDevice, linkAccountEmail } from "./backend.js";

export async function main(argv) {
  const [product, command, ...rest] = argv;
  if (product !== "claude") return usage(1);
  if (command === "setup") return await setup(rest);
  if (command === "link") return await link(rest);
  if (command === "restore") return restore(rest);
  if (command === "doctor") return await doctor(rest);
  if (command === "run") {
    process.exitCode = await runClaude(rest);
    return;
  }
  if (command === "statusline") {
    const flags = parseFlags(rest);
    await runStatusLine({ statePath: flags.state, prevPath: flags.prev });
    return;
  }
  return usage(1);
}

async function setup(argv) {
  const flags = parseFlags(argv);
  const home = homedir();
  const shell = flags.shell || shellFromEnv();
  const rcPath = flags.rc || defaultRcPath(shell);
  const realClaudePath = locateRealClaude({
    explicit: flags["real-claude"],
    home,
  });
  if (!realClaudePath) throw new Error("could not find `claude` on PATH; pass --real-claude /path/to/claude");
  writeTerminalConfig(home, {
    ...readTerminalConfig(home),
    realClaudePath,
    setupAt: new Date().toISOString(),
    shell,
    rcPath,
  });
  const result = installShellBlock({ shell, rcPath, force: flags.force === true });
  console.log(`FreeAI Claude setup complete`);
  console.log(`real claude: ${realClaudePath}`);
  console.log(`shell rc: ${result.rcPath}`);
  console.log(`restart your shell or source ${result.rcPath}`);

  // Link this machine's device to a FreeAI account so Claude Code credits land
  // in the user's portal balance. Without this they accrue to an anonymous
  // device. Skippable (--no-link, or just press enter) and non-interactive-safe.
  if (flags["no-link"] === true) {
    console.log("Skipped account link (--no-link). Run `freeai claude link` to attribute credits to your FreeAI account.");
    return;
  }
  await linkStep({ home, emailArg: flags.email, allowPrompt: true });
}

async function link(argv) {
  const flags = parseFlags(argv);
  const emailArg = typeof flags.email === "string" ? flags.email : flags._[0];
  const res = await linkStep({ home: homedir(), emailArg, allowPrompt: true });
  if (res.skipped || res.error) process.exitCode = 1;
}

// Shared by `setup` and `link`. Resolves an email (flag/arg, else an interactive
// prompt on a TTY), emails the magic link, and records that a link was requested
// so `doctor` can show it. Never throws — a failed link must not break setup.
async function linkStep({ home, emailArg, allowPrompt }) {
  let email = String(emailArg || "").trim();
  if (!email && allowPrompt && process.stdin.isTTY) {
    email = await promptLine("Email to link your FreeAI account (press enter to skip): ");
  }
  email = String(email || "").trim();
  if (!email) {
    console.log("No email linked — run `freeai claude link` to attribute Claude Code credits to your FreeAI account.");
    return { skipped: true };
  }
  try {
    const backend = defaultBackend({ home, env: process.env });
    const res = await linkAccountEmail(home, backend, email);
    writeTerminalConfig(home, {
      ...readTerminalConfig(home),
      linkEmail: res.email,
      linkRequestedAt: new Date().toISOString(),
    });
    console.log(`Magic link sent to ${res.email}. Open it to finish linking your FreeAI account; future Claude Code credits will land in your balance.`);
    return { sent: true, email: res.email };
  } catch (err) {
    console.error(`Could not send the link: ${String(err?.message || err)} (run \`freeai claude link\` to retry).`);
    return { error: String(err?.message || err) };
  }
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function restore(argv) {
  const flags = parseFlags(argv);
  const cfg = readTerminalConfig(homedir());
  const shell = flags.shell || cfg.shell || shellFromEnv();
  const rcPath = flags.rc || cfg.rcPath || defaultRcPath(shell);
  const result = restoreShellBlock({ shell, rcPath });
  console.log(result.changed
    ? `Removed FreeAI Claude shell block from ${result.rcPath}`
    : `No FreeAI Claude shell block found in ${result.rcPath}`);
}

async function doctor(argv) {
  const flags = parseFlags(argv);
  const home = homedir();
  const cfg = readTerminalConfig(home);
  const shell = flags.shell || cfg.shell || shellFromEnv();
  const rcPath = flags.rc || cfg.rcPath || defaultRcPath(shell);
  const realClaudePath = locateRealClaude({ storedPath: cfg.realClaudePath, home });
  const report = {
    ok: !!realClaudePath,
    realClaudePath: realClaudePath || null,
    configPath: terminalConfigPath(home),
    shell,
    rcPath,
    cliPath: fileURLToPath(new URL("../bin/freeai.js", import.meta.url)),
    linkEmail: cfg.linkEmail || null,
  };
  console.log(JSON.stringify(report, null, 2));

  // The local report above can be green while no ad ever serves, because the ad
  // path depends on the backend. Probe it end-to-end unless asked to skip.
  if (flags["no-backend"] === true) return;
  console.log(JSON.stringify(await probeBackend(home), null, 2));
}

// Run the same pipeline `freeai claude run` uses to prepare an ad, reporting the
// outcome and latency of each step so a failure (network, cold start, no
// inventory) is visible instead of silently degrading to plain `claude`.
async function probeBackend(home) {
  const backend = defaultBackend({ home, env: process.env });
  const result = { backend: resolveApiBase({ home, env: process.env }), steps: {} };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const summary = await fn();
      result.steps[name] = { ok: true, ms: Date.now() - t0, ...(summary || {}) };
      return true;
    } catch (err) {
      result.steps[name] = { ok: false, ms: Date.now() - t0, error: String(err?.message || err) };
      return false;
    }
  };

  let ads = [];
  let device = null;
  await step("config", async () => ({ serving: (await backend.config()).serving }));
  await step("ads", async () => { ads = await backend.ads(); return { count: ads.length, first: ads[0]?.line || null }; });
  await step("device", async () => { device = await ensureDevice(home, backend); return { deviceId: `${device.deviceId.slice(0, 8)}…` }; });
  if (device) {
    // Whether credits attribute to a FreeAI account or an anonymous device.
    await step("account", async () => await backend.linkStatus(device));
  }
  if (device && ads[0]) {
    await step("clickIntent", async () => ({ trackingUrl: await backend.createClickIntent(device, ads[0].id) }));
  }

  const s = result.steps;
  result.adsWillServe = !!(s.config?.ok && s.config.serving && s.ads?.ok && s.ads.count > 0
    && s.device?.ok && s.clickIntent?.ok);
  return result;
}

function usage(code) {
  console.error(`Usage:
  freeai claude setup [--shell zsh|bash|fish] [--rc PATH] [--real-claude PATH] [--force] [--email YOU@EXAMPLE.COM] [--no-link]
  freeai claude link [--email YOU@EXAMPLE.COM]
  freeai claude run [...claude args]
  freeai claude restore [--shell zsh|bash|fish] [--rc PATH]
  freeai claude doctor [--no-backend]
`);
  process.exitCode = code;
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") { out.force = true; continue; }
    if (arg.startsWith("--") && arg.includes("=")) {
      const [k, ...rest] = arg.slice(2).split("=");
      out[k] = rest.join("=");
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
      continue;
    }
    out._.push(arg);
  }
  return out;
}
