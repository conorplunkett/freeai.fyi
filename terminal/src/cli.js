import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { installShellBlock, restoreShellBlock, shellFromEnv, defaultRcPath } from "./shell.js";
import { locateRealClaude, readTerminalConfig, writeTerminalConfig } from "./claude.js";
import { runClaude } from "./run.js";
import { runStatusLine } from "./statusline.js";
import { terminalConfigPath } from "./paths.js";

export async function main(argv) {
  const [product, command, ...rest] = argv;
  if (product !== "claude") return usage(1);
  if (command === "setup") return setup(rest);
  if (command === "restore") return restore(rest);
  if (command === "doctor") return doctor(rest);
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

function setup(argv) {
  const flags = parseFlags(argv);
  const shell = flags.shell || shellFromEnv();
  const rcPath = flags.rc || defaultRcPath(shell);
  const realClaudePath = locateRealClaude({
    explicit: flags["real-claude"],
    home: homedir(),
  });
  if (!realClaudePath) throw new Error("could not find `claude` on PATH; pass --real-claude /path/to/claude");
  writeTerminalConfig(homedir(), {
    ...readTerminalConfig(homedir()),
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

function doctor(argv) {
  const flags = parseFlags(argv);
  const cfg = readTerminalConfig(homedir());
  const shell = flags.shell || cfg.shell || shellFromEnv();
  const rcPath = flags.rc || cfg.rcPath || defaultRcPath(shell);
  const realClaudePath = locateRealClaude({ storedPath: cfg.realClaudePath, home: homedir() });
  const report = {
    ok: !!realClaudePath,
    realClaudePath: realClaudePath || null,
    configPath: terminalConfigPath(homedir()),
    shell,
    rcPath,
    cliPath: fileURLToPath(new URL("../bin/freeai.js", import.meta.url)),
  };
  console.log(JSON.stringify(report, null, 2));
}

function usage(code) {
  console.error(`Usage:
  freeai claude setup [--shell zsh|bash|fish] [--rc PATH] [--real-claude PATH] [--force]
  freeai claude run [...claude args]
  freeai claude restore [--shell zsh|bash|fish] [--rc PATH]
  freeai claude doctor
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
