# Changelog

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
