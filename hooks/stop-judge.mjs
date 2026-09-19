#!/usr/bin/env node
// Stop hook: never judges inline. Spawns the judge detached and returns.
// Other Stop hooks may block and re-enter the turn; on re-entry
// (stop_hook_active) nothing is spawned, the final stop will.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log, readConfig, readStdinJson } from "../lib/jev.mjs";

const JUDGE = fileURLToPath(new URL("../bin/judge.mjs", import.meta.url));

async function main() {
  const config = readConfig();
  if (config.mode === "off") return;
  const input = await readStdinJson();
  if (!input || input.hook_event_name !== "Stop") return;
  if (input.stop_hook_active) return;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const args = [JUDGE, "--cwd", cwd, "--reason", "stop"];
  if (typeof input.session_id === "string") args.push("--session", input.session_id);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  log(config, ["stop", config.mode, "spawned", cwd, String(child.pid)]);
}

main().catch(() => {});
