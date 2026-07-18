#!/usr/bin/env node
// Example HOOK_CMD hook: desktop notification when a loop is detected.
// Zero dependencies — no npm packages, no external services. Uses whatever
// the OS already ships: a Windows toast (PowerShell/WinRT), macOS
// `osascript`, or Linux `notify-send`. Copy it anywhere and point HOOK_CMD
// at it:
//
//   /loop-police set HOOK_CMD=node /path/to/hook.mjs
//
// The detection payload arrives as the LAST argv element (JSON, schema in the
// README). Exit code and output are ignored by loop-police, so a hook can
// never break detection — but a non-zero exit shows a one-time warning, which
// is useful while developing one.
//
// Optional: to ALSO push to a phone via https://ntfy.sh, subscribe to a topic
// at https://ntfy.sh/<topic> (or the mobile app) and set:
//   export LOOP_POLICE_NTFY_TOPIC=my-secret-topic

import { spawnSync } from "node:child_process";

const payload = JSON.parse(process.argv.at(-1));

const title = "loop-police";
const body =
  `${payload.model?.id ?? "unknown model"} hit ${payload.event} ` +
  `(turn ${payload.turnIndex}, ${payload.consecutiveLoops} consecutive) in ${payload.cwd}`;

// --- local desktop notification (default, fully offline) ---

// Text travels via env vars so no shell escaping is ever needed.
const env = { ...process.env, LP_TITLE: title, LP_BODY: body };

const WIN_TOAST = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName("text")
$null = $texts.Item(0).AppendChild($xml.CreateTextNode($env:LP_TITLE))
$null = $texts.Item(1).AppendChild($xml.CreateTextNode($env:LP_BODY))
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

let r;
if (process.platform === "win32") {
  r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_TOAST], { env });
} else if (process.platform === "darwin") {
  r = spawnSync("osascript", ["-e", "display notification (system attribute \"LP_BODY\") with title (system attribute \"LP_TITLE\")"], { env });
} else {
  r = spawnSync("notify-send", ["--urgency=normal", title, body], { env });
}
if (r.error || r.status !== 0) process.exitCode = 1; // one-time warning in pi while developing

// --- optional ntfy.sh push (only when a topic is configured) ---

const topic = process.env.LOOP_POLICE_NTFY_TOPIC;
if (topic) {
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: { Title: title, Priority: "default", Tags: "warning" },
    body,
  });
}
