// Example pi extension consuming loop-police detections in-process via the
// shared extension event bus — no external process, no config. It keeps a
// per-session counter in the status bar: "⚠ 3 loops (tool_loop)".
//
// This file is NOT loaded by installing pi-loop-police. To use it, copy it
// into your pi extensions directory (e.g. ~/.pi/agent/extensions/).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Mirrors buildDetectionPayload() in loop-police.ts (see README for the schema).
interface LoopDetection {
  event: string;
  timestamp: string;
  model: { id: string; name: string; provider: string } | null;
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  turnIndex: number;
  consecutiveLoops: number;
  details: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  // Bus handlers only receive the payload, so grab the UI context from a
  // lifecycle event and keep it around.
  let ui: ExtensionContext["ui"] | undefined;
  let count = 0;

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    count = 0;
    ui.setStatus("loop-count", undefined);
  });

  pi.events.on("loop-police:detection", (data) => {
    const detection = data as LoopDetection;
    count++;
    ui?.setStatus("loop-count", `⚠ ${count} loop${count === 1 ? "" : "s"} (${detection.event})`);
  });
}
