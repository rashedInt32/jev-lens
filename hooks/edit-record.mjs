#!/usr/bin/env node
// PostToolUse hook on Edit, Write, MultiEdit, and Bash: record which files a
// session touched. Metadata only; git is the truth for what changed. The
// judge uses this log to tell agent edits from the human's own typing.
// Never calls Jev.
//
// Bash commands go through the static write detector: redirects, tee,
// sed -i, cp/mv/rm, git checkout --, and scripts that call a file-writing
// API. A write whose target cannot be resolved is recorded as "(script)" so
// the judge still knows an agent edit happened.

import { isAbsolute, relative, resolve } from "node:path";
import { readConfig, readStdinJson } from "../lib/jev.mjs";
import { readState, repoRoot, writeState } from "../lib/repo.mjs";
import { shellWrites } from "../lib/shell.mjs";

const MAX_EDITS = 500;

function targetsOf(input, cwd) {
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string") return [];
    const writes = shellWrites(command, { cwd });
    if (!writes) return [];
    return writes.targets.map((t) => (t.startsWith("(") ? t : isAbsolute(t) ? t : resolve(cwd, t)));
  }
  const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
  return typeof file === "string" ? [file] : [];
}

async function main() {
  const config = readConfig();
  if (config.mode === "off") return;
  const input = await readStdinJson();
  if (!input || input.hook_event_name !== "PostToolUse") return;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const targets = targetsOf(input, cwd);
  if (targets.length === 0) return;
  const root = repoRoot(cwd);
  if (!root) return;
  const ts = new Date().toISOString();
  const entries = [];
  for (const target of targets) {
    let file = target;
    if (!target.startsWith("(")) {
      file = relative(root, target);
      if (file.startsWith("..")) continue;
    }
    entries.push({ ts, session_id: input.session_id ?? null, file, tool: input.tool_name ?? null });
  }
  if (entries.length === 0) return;
  const state = readState(config, root) ?? {};
  const edits = [...(state.edits ?? []), ...entries].slice(-MAX_EDITS);
  writeState(config, root, { ...state, edits });
}

main().catch(() => {});
