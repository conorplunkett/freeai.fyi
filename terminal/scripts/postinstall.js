// Printed once after `npm install -g @freeai.fyi/terminal` to point users at
// the required next step. npm prints nothing on its own, so without this a
// fresh global install leaves a `freeai` binary with no hint that
// `freeai claude setup` is what actually wires up Claude Code.
//
// Stays quiet unless this is a global install, skips when setup has already
// run (so upgrades/reinstalls don't nag), and never fails the install.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  // Only nudge on global installs — npm sets this for `-g`. Skips dependency
  // installs and in-repo dev installs.
  if (process.env.npm_config_global !== "true") process.exit(0);

  // Already set up? Don't nag on reinstalls or upgrades.
  const configPath = join(homedir(), ".freeai", "claude", "config.json");
  if (existsSync(configPath)) process.exit(0);

  const b = "[1m";
  const o = "[38;2;217;119;87m"; // FreeAI accent orange
  const r = "[0m";
  process.stdout.write(
    `\n${o}FreeAI installed.${r} One more step to start earning credits:\n\n` +
      `  ${b}freeai claude setup${r}\n\n` +
      `It wires Claude Code to FreeAI, then use ${b}claude${r} exactly as you always have.\n\n`,
  );
} catch {
  // Never block the install over a banner.
}
process.exit(0);
