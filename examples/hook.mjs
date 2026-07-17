#!/usr/bin/env node
// Example HOOK_CMD hook: push a notification via https://ntfy.sh when a loop
// is detected. Zero dependencies — copy it anywhere and point HOOK_CMD at it:
//
//   /loop-police set HOOK_CMD=node /path/to/hook.mjs
//
// The detection payload arrives as the LAST argv element (JSON, schema in the
// README). Exit code and output are ignored by loop-police, so a hook can
// never break detection — but a non-zero exit shows a one-time warning, which
// is useful while developing one.
//
// Subscribe to your topic at https://ntfy.sh/<topic> (or the mobile app), then:
//   export LOOP_POLICE_NTFY_TOPIC=my-secret-topic

const payload = JSON.parse(process.argv.at(-1));

const topic = process.env.LOOP_POLICE_NTFY_TOPIC;
if (!topic) process.exit(0); // not configured — do nothing, succeed silently

await fetch(`https://ntfy.sh/${topic}`, {
  method: "POST",
  headers: { Title: "loop-police", Priority: "default", Tags: "warning" },
  body:
    `${payload.model?.id ?? "unknown model"} hit ${payload.event} ` +
    `(turn ${payload.turnIndex}, ${payload.consecutiveLoops} consecutive) in ${payload.cwd}`,
});
