// Status bar surface — one sponsored line next to a spinner glyph, rendered
// in the VS Code status bar. This is the original (and currently only
// shipped) FreeAI ad surface.

function createStatusBarAdapter(vscode) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);

  return {
    id: "statusBar",
    item, // exposed so the extension can push it onto context.subscriptions

    // m: { earnings, impressions, clicks, sharePct }
    renderIdle(m) {
      item.text = `$(sparkle) freeai  $${m.earnings.toFixed(2)}`;
      item.tooltip = new vscode.MarkdownString(
        `**FreeAI.fyi** — you keep ${m.sharePct}%\n\n` +
          `Earned: **$${m.earnings.toFixed(2)}**  ·  ${m.impressions.toLocaleString()} impressions  ·  ${m.clicks} clicks\n\n` +
          `_Click to open your earnings dashboard._`
      );
      item.command = "freeai.showEarnings";
      item.color = undefined;
      item.show();
    },

    // m: { glyph, word, ad: { brand, line }, sharePct }
    renderActive(m) {
      item.text = `${m.glyph} ${m.word}…  ·  ${m.ad.line}`;
      item.tooltip = new vscode.MarkdownString(
        `**Sponsored** · ${m.ad.brand}\n\n${m.ad.line}\n\n_Click to open. You keep ${m.sharePct}% of this impression._`
      );
      item.command = "freeai.openCurrentAd";
      item.color = new vscode.ThemeColor("charts.green");
      item.show();
    },

    dispose() {
      item.dispose();
    },
  };
}

module.exports = { createStatusBarAdapter };
