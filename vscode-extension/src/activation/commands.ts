import * as vscode from "vscode";
import type { TargetAdapter } from "../adapters/types";
import type { DebugController } from "../debug";
import type { AuthClient } from "../auth/client";
import type { UpdateClient } from "../update/client";
import type { SessionState } from "../sessionState";
import type { SbState } from "../statusbar";
import { buildLabel, buildVersion } from "../buildinfo";
import { dlog } from "../log";
import { errMsg } from "../util/errMsg";
import { setWebviewMode } from "../modes";
import { clearAdRotationOnSignOut } from "./adRotation";
import { noteMetricsSignOut } from "../metrics/client";
import { noteFleetSignalsSignOut } from "../fleetSignals";

/** Byte-exact revert of the Codex target, never throws. Used at every CC
 *  teardown site (kill / webview-off / Restore command / deactivate) so Codex
 *  is never left patched when CC isn't. */
export function restoreCodexSafe(codexAdapter: TargetAdapter | null): void {
  try { codexAdapter?.restore(); } catch { /* ignore */ }
}

export function registerCommands(
  ctx: vscode.ExtensionContext,
  adapter: TargetAdapter,
  codexAdapter: TargetAdapter | null,
  auth: AuthClient,
  debugCtl: DebugController,
  statusBar: { set: (s: SbState) => void },
  session: SessionState,
  updater: UpdateClient,
  ccVersion: string,
  showActive: () => Promise<void>,
): void {
  const guardCmd = <T>(id: string, fn: () => Promise<T> | T) =>
    async (): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        dlog("ext", "cmd.err", {
          id,
          msg: errMsg(e),
        });
      }
    };

  const cmdSignIn = guardCmd("signIn", async () => {
    if (await auth.signIn()) {
      session.set({ signedIn: true, authHealthy: "ok" });
      // Tiered auto-enable: turn injection back on for a first-run user
      // (neverToggled) OR a user who was running ads before they signed out
      // (K_PRESIGNOUT). A deliberate "Disable FreeAI" survives — see
      // DebugController.shouldAutoEnableOnSignIn(). Pre-fix this used the
      // bare neverToggled() gate, so a sign-out (which writes K_ON=false) left
      // the user permanently disabled on the next sign-in.
      if (debugCtl?.shouldAutoEnableOnSignIn()) {
        await debugCtl!.setOn(true);
        session.set({ injectionOn: true });
      }
      // Consume the one-shot sign-out memory regardless of the decision.
      await debugCtl?.clearSignOutMemory();
      await showActive();
    }
  });
  const cmdSignOut = guardCmd("signOut", async () => {
    // Drop the rotation queue and shared ad refs BEFORE the restore: a
    // rotation/refresh tick firing inside the doSignOut await could otherwise
    // re-patch CC with the real ads it is about to give up. The next
    // portfolio refresh re-applies (demo) ads with demo tokens. The metrics
    // hook resets the demoted-stamp so post-sign-out demo traffic isn't
    // mislabeled as a mid-session token death.
    clearAdRotationOnSignOut();
    noteMetricsSignOut();
    // Drop piggybacked balances too — they belong to the old identity and
    // must not repaint a green earnings bar after sign-out.
    noteFleetSignalsSignOut();
    await debugCtl?.doSignOut();
    statusBar.set({ kind: "signed-out" });
    session.set({ signedIn: false, authHealthy: "unknown",
                  hasAd: false, injectionOn: false });
  });
  const cmdRestore = guardCmd("restore", async () => {
    setWebviewMode(false);
    await debugCtl.setOn(false);
    session.set({ injectionOn: false, hasAd: false });
  });
  const cmdStatus = guardCmd("status", () => {
    const st = auth.storageInfo();
    vscode.window.showInformationMessage(
      `FreeAI (Claude Code ${ccVersion}) — ${
        auth.signedIn() ? "signed in" : "signed out"} · ${buildLabel()}`
      + ` · store: ${st.scheme}${
        st.keyringDurable === false ? " (keyring not durable — using file)" : ""}`);
  });
  const cmdCheckUpdates = guardCmd("checkUpdates", async () => {
    try {
      const installed = await updater.checkOnce();
      if (installed) {
        void vscode.window.showInformationMessage?.(
          "FreeAI: update installed; the extension host will restart.");
      } else {
        void vscode.window.showInformationMessage?.(
          `FreeAI: already up to date (v${buildVersion()}).`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage?.(
        `FreeAI: update check failed — `
        + `${errMsg(e, 200)}`);
    }
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("freeai.signIn", cmdSignIn),
    vscode.commands.registerCommand("freeai-legacy.signIn", cmdSignIn),
    vscode.commands.registerCommand("freeai.signOut", cmdSignOut),
    vscode.commands.registerCommand("freeai-legacy.signOut", cmdSignOut),
    vscode.commands.registerCommand("freeai.restore", cmdRestore),
    vscode.commands.registerCommand("freeai-legacy.restore", cmdRestore),
    vscode.commands.registerCommand("freeai.status", cmdStatus),
    vscode.commands.registerCommand("freeai-legacy.status", cmdStatus),
    vscode.commands.registerCommand("freeai.checkUpdates", cmdCheckUpdates),
  );
}
