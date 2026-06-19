import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const MARKER_START = "# >>> FreeAI Claude terminal integration >>>";
export const MARKER_END = "# <<< FreeAI Claude terminal integration <<<";

export function shellFromEnv(env = process.env) {
  const shell = env.SHELL || "";
  if (shell.endsWith("/fish")) return "fish";
  if (shell.endsWith("/bash")) return "bash";
  return "zsh";
}

export function defaultRcPath(shell, home = homedir()) {
  if (shell === "fish") return join(home, ".config", "fish", "config.fish");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".zshrc");
}

export function shellBlock(shell) {
  if (shell === "fish") {
    return `${MARKER_START}
function claude
    freeai claude run $argv
end
${MARKER_END}
`;
  }
  return `${MARKER_START}
alias claude="freeai claude run"
${MARKER_END}
`;
}

export function stripFreeAiBlock(content) {
  const re = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`, "g");
  return content.replace(re, "");
}

export function hasNonFreeAiClaudeDefinition(content, shell) {
  const stripped = stripFreeAiBlock(content);
  if (shell === "fish") {
    return /^\s*(?:function\s+claude\b|alias\s+claude\b)/m.test(stripped);
  }
  return /^\s*(?:alias\s+claude=|function\s+claude\b|claude\s*\(\s*\))/m.test(stripped);
}

export function installShellBlock({
  shell = shellFromEnv(),
  rcPath = defaultRcPath(shell),
  force = false,
} = {}) {
  const current = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  if (!force && hasNonFreeAiClaudeDefinition(current, shell)) {
    throw new Error(`found an existing claude alias/function in ${rcPath}; rerun with --force to replace only the FreeAI block`);
  }
  const nextBlock = shellBlock(shell);
  const without = stripFreeAiBlock(current).replace(/\s*$/, "");
  const next = without ? `${without}\n${nextBlock}` : nextBlock;
  mkdirSync(dirname(rcPath), { recursive: true });
  writeFileSync(rcPath, next, "utf8");
  return { rcPath, shell, changed: next !== current };
}

export function restoreShellBlock({
  shell = shellFromEnv(),
  rcPath = defaultRcPath(shell),
} = {}) {
  if (!existsSync(rcPath)) return { rcPath, shell, changed: false };
  const current = readFileSync(rcPath, "utf8");
  const next = stripFreeAiBlock(current);
  if (next !== current) writeFileSync(rcPath, next, "utf8");
  return { rcPath, shell, changed: next !== current };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
