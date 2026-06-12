# Changelog

## 0.3.0

- Viewability: impressions only count while the VS Code window is focused —
  an unattended machine no longer accrues earnings.
- Ad surfaces are now adapters (`src/adapters/`); the status bar is the first,
  with the Claude Code panel, Codex panel, and CLI spinner-verb surfaces to
  follow.
- Device credentials moved from `globalState` into VS Code SecretStorage (the
  OS keychain); existing installs migrate automatically.
- Server killswitch: in server mode the extension checks `GET /v1/config` at
  startup and every 5 minutes and goes idle if serving is paused.

## 0.2.1

- Server-side click verification: in server mode, clicks open a single-use
  tracking URL (`/v1/go/:token`) so they're counted by the backend, not the
  client.
- Escape advertiser ad text in the earnings webview.

## 0.2.0

- Server mode: set `betterbacks.serverUrl` to pull auction-ranked ads from the
  live API and batch impressions/clicks to it (idempotent, offline-safe).
  Empty by default — local/demo mode unchanged.

## 0.1.0

- Initial release. 🤑
- Sponsored line served in the status bar next to a spinner while your agent works.
- Impression accrual (one per 5 seconds), clicks worth 50× an impression.
- **90% revenue share** to the developer — the better split.
- Earnings dashboard webview with the live bid market.
- Auto-show while an integrated terminal is focused.
- Configurable revenue share, gross CPM, and blocked ad categories.
