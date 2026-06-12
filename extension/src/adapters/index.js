// Ad surface adapters.
//
// extension.js decides WHAT to show (the view model: which ad, spinner frame,
// earnings totals); adapters decide WHERE it shows. Every adapter implements:
//
//   { id, renderIdle(model), renderActive(model), dispose() }
//
// Today the status bar is the only shipped surface. Planned surfaces slot in
// here without touching the orchestrator: the Claude Code VS Code panel, the
// Codex panel, and the CLI spinner verb.

const { createStatusBarAdapter } = require("./statusBar");

function createAdapters(vscode) {
  const factories = [createStatusBarAdapter];
  return factories.map((create) => create(vscode)).filter(Boolean);
}

module.exports = { createAdapters };
