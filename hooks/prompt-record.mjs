#!/usr/bin/env node
// UserPromptSubmit hook: record what the human asked, per repo, so the judge
// can answer "which ask caused this file" and survive a Claude restart.
// Never calls Jev.

import { readConfig, readStdinJson } from "../lib/jev.mjs";
import { readState, repoRoot, writeState } from "../lib/repo.mjs";
import { cleanPrompt } from "../lib/transcript.mjs";

const MAX_PROMPTS = 32;

async function main() {
  const config = readConfig();
  if (config.mode === "off") return;
  const input = await readStdinJson();
  if (!input || input.hook_event_name !== "UserPromptSubmit" || typeof input.prompt !== "string") return;
  if (/^\s*[/<]/.test(input.prompt)) return;
  const text = cleanPrompt(input.prompt);
  if (!text || text.split(/\s+/).length < 2) return;
  const root = repoRoot(typeof input.cwd === "string" ? input.cwd : process.cwd());
  if (!root) return;
  const state = readState(config, root) ?? {};
  const prompts = [...(state.prompts ?? []), { ts: new Date().toISOString(), session_id: input.session_id ?? null, text: text.slice(0, 4000) }].slice(-MAX_PROMPTS);
  writeState(config, root, { ...state, prompts });
}

main().catch(() => {});
