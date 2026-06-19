import { randomUUID } from "node:crypto";
import { locateClaudeCliTranscript, readTranscriptActivity } from "./transcript.js";
import { readState, updateState } from "./state.js";

export function startSessionMonitor({
  statePath,
  home,
  backend,
  device,
  ad,
  intervalMs = 1000,
  viewThresholdMs = 5000,
  heartbeatFreshMs = 4000,
  transcriptFreshMs = 4000,
} = {}) {
  let activeStartedAt = null;
  let sentThisSegment = false;
  let batchKey = "";
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const state = readState(statePath);
    if (!state) return;
    const heartbeatFresh = state.lastHeartbeatMs
      && (now - state.lastHeartbeatMs) <= heartbeatFreshMs;
    const transcriptPath = state.transcriptPath || locateClaudeCliTranscript(home);
    const activity = transcriptPath ? readTranscriptActivity(transcriptPath, now) : null;
    const active = !!heartbeatFresh && !!activity
      && activity.active && activity.ageMs <= transcriptFreshMs;

    updateState(statePath, (next) => {
      next.active = active;
      next.transcriptPath = transcriptPath || next.transcriptPath || "";
      if (active) {
        next.lastActiveMs = now;
        if (!next.activeStartedAt) next.activeStartedAt = now;
      } else {
        next.activeStartedAt = null;
      }
      return next;
    });

    if (!active) {
      activeStartedAt = null;
      sentThisSegment = false;
      batchKey = "";
      return;
    }
    if (!activeStartedAt) activeStartedAt = now;
    if (sentThisSegment || (now - activeStartedAt) < viewThresholdMs) return;
    if (!batchKey) batchKey = randomUUID();
    try {
      await backend.sendImpression(device, ad.id, batchKey);
      sentThisSegment = true;
      updateState(statePath, (next) => {
        next.impression = { sent: true, batchKey, sentAt: Date.now() };
        return next;
      });
    } catch {
      updateState(statePath, (next) => {
        next.impression = { sent: false, batchKey, sentAt: 0 };
        return next;
      });
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  try { timer.unref?.(); } catch { /* ignore */ }
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
