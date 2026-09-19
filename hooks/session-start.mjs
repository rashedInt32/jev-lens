#!/usr/bin/env node
// SessionStart hook: make sure the repo has a baseline before the agent's
// first edit, so pre-existing human changes are never judged as agent work.
// Never calls Jev.

import { log, readConfig, readStdinJson } from "../lib/jev.mjs";
import { readState, repoRoot, snapshotTree, writeState } from "../lib/repo.mjs";

async function main() {
  const config = readConfig();
  if (config.mode === "off") return;
  const input = await readStdinJson();
  if (!input || input.hook_event_name !== "SessionStart") return;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  if (!root) return;
  const state = readState(config, root);
  if (state?.baseline) return;
  const baseline = snapshotTree(root);
  writeState(config, root, { ...(state ?? {}), baseline, baseline_at: new Date().toISOString(), baseline_reason: "session-start" });
  log(config, ["session-start", config.mode, "baseline-created", root, baseline]);
}

main().catch(() => {});
