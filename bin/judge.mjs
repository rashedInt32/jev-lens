#!/usr/bin/env node
// The judge. Spawned detached by the Stop hook, or run by hand from nvim.
//
//   node bin/judge.mjs --cwd <dir> [--session <id>] [--reason stop|manual]
//                      [--reviewed] [--force]
//
// Diffs the repo against its baseline tree, asks Jev, writes verdict.json.
// Any failure logs a line and writes nothing. Silence is never green.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { candidates, commentRemovalOnly } from "../lib/debris.mjs";
import { clip, log, readConfig, readKey, writeJsonAtomic } from "../lib/jev.mjs";
import { isIgnored, redact } from "../lib/redact.mjs";
import { changedIgnoringWhitespace, deleteVerdict, diffTrees, headTree, isClean, readState, readVerdict, repoDir, repoRoot, snapshotTree, writeState, writeVerdict } from "../lib/repo.mjs";
import { collectRules } from "../lib/rules.mjs";
import { composeVerdict, judgeAll } from "../lib/verdict.mjs";

function parseArgs(argv) {
  const args = { cwd: process.cwd(), reason: "manual", reviewed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--session") args.session = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--reviewed") args.reviewed = true;
    else if (a === "--force") args.force = true;
  }
  return args;
}

/** Session file for a Claude Code session id, for the popup's jump key. */
function findSession(sessionId, home = homedir()) {
  if (!sessionId) return null;
  const dir = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "sessions") : join(home, ".claude", "sessions");
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (s.sessionId === sessionId) return { id: sessionId, name: s.name ?? null, pid: s.pid ?? null, tmux: s.tmux ?? null, cwd: s.cwd ?? null };
      } catch {
        // partial write
      }
    }
  } catch {
    // no sessions dir
  }
  return { id: sessionId, name: null, pid: null, tmux: null, cwd: null };
}

function realDir(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function judge(args, config = readConfig()) {
  if (config.mode === "off") return { outcome: "off" };
  const root = repoRoot(args.cwd);
  if (!root) {
    if (config.mode === "shadow") log(config, ["judge", config.mode, "no-repo", args.cwd]);
    return { outcome: "no-repo" };
  }

  let state = readState(config, root);
  if (!state || !state.baseline) {
    const baseline = snapshotTree(root);
    state = { ...(state ?? {}), baseline, baseline_at: new Date().toISOString(), baseline_reason: "first-run" };
    writeState(config, root, state);
    log(config, ["judge", config.mode, "baseline-created", root, baseline]);
    return { outcome: "baseline-created", root };
  }

  if (args.reviewed) {
    const tree = snapshotTree(root);
    const verdict = readVerdict(config, root);
    state = { ...state, baseline: tree, baseline_at: new Date().toISOString(), baseline_reason: "reviewed", reviewed_id: verdict?.id ?? null };
    writeState(config, root, state);
    if (verdict) writeVerdict(config, root, { ...verdict, reviewed: true });
    log(config, ["judge", config.mode, "reviewed", root, tree]);
    return { outcome: "reviewed", root };
  }

  // A commit that leaves the tree clean is a review by the act of committing.
  const head = headTree(root);
  if (head && head !== state.baseline && isClean(root)) {
    state = { ...state, baseline: head, baseline_at: new Date().toISOString(), baseline_reason: "commit-clean" };
    writeState(config, root, state);
    deleteVerdict(config, root);
    log(config, ["judge", config.mode, "baseline-commit-clean", root, head]);
    return { outcome: "baseline-commit-clean", root };
  }

  const tree = snapshotTree(root);
  if (tree === state.baseline) {
    deleteVerdict(config, root);
    writeState(config, root, { ...state, last_judged_tree: tree });
    log(config, ["judge", config.mode, "no-diff", root]);
    return { outcome: "no-diff", root };
  }
  // --force is a person pressing re-judge. They know the tree has not moved
  // and are asking anyway, so spend the call.
  if (!args.force && tree === state.last_judged_tree && readVerdict(config, root)) {
    log(config, ["judge", config.mode, "coalesced", root, tree]);
    return { outcome: "coalesced", root };
  }

  const key = readKey(config);
  if (!key) {
    log(config, ["judge", config.mode, "no-key", root]);
    return { outcome: "no-key", root };
  }

  const all = diffTrees(root, state.baseline, tree);
  const skipped = [];
  const kept = [];
  // Compare real paths: git reports /private/tmp where $TMPDIR says /tmp.
  const dataReal = realDir(config.dataDir);
  const dataInside = dataReal && dataReal.startsWith(root + "/") ? dataReal.slice(root.length + 1) + "/" : null;
  for (const f of all) {
    if (f.binary || isIgnored(f.path, config.ignore) || (dataInside && f.path.startsWith(dataInside))) skipped.push(f.path);
    else kept.push({ ...f, patch: redact(f.patch) });
  }
  // Clip each patch, then drop the largest files past the total cap so the
  // rest can still be judged. Dropped files are listed as unjudged.
  const perFileCap = Math.max(2000, Math.floor(config.maxChars / Math.max(1, Math.min(kept.length, 20))));
  for (const f of kept) f.patch = clip(f.patch, perFileCap);
  kept.sort((a, b) => a.patch.length - b.patch.length);
  const judgedSet = [];
  const unjudged = [];
  let total = 0;
  for (const f of kept) {
    if (judgedSet.length < config.maxFiles && total + f.patch.length <= config.maxChars) {
      judgedSet.push(f);
      total += f.patch.length;
    } else unjudged.push(f);
  }
  // Question ids are positional, so judge in a stable order.
  judgedSet.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (judgedSet.length === 0 && unjudged.length === 0) {
    deleteVerdict(config, root);
    log(config, ["judge", config.mode, "all-ignored", root, skipped.join(",")]);
    return { outcome: "all-ignored", root };
  }

  // Gates that need no judgment. Each one clears any pending verdict and
  // records the tree so the next stop on the same tree coalesces.
  const settle = (outcome, detail) => {
    deleteVerdict(config, root);
    writeState(config, root, { ...readState(config, root), last_judged_tree: tree });
    log(config, ["judge", config.mode, outcome, root, detail ?? ""]);
    return { outcome, root };
  };
  // These three are heuristics for "not worth asking about". --force is a
  // person overriding that judgment, so they do not apply. Skipping them also
  // keeps a forced re-judge from deleting the verdict it was asked to refresh.
  if (!args.force) {
    // A formatter run: nothing changed once whitespace is ignored.
    if (!changedIgnoringWhitespace(root, state.baseline, tree, kept.map((f) => f.path))) {
      return settle("whitespace-only");
    }
    // Only comment lines were deleted: no behavior effect, nothing to strip.
    if (commentRemovalOnly(kept)) {
      return settle("comment-removal-only");
    }
    // No agent edit on record since the baseline: this is the human's typing.
    if (config.requireEdits) {
      const since = state.baseline_at ?? "";
      const agentEdits = (state.edits ?? []).filter((e) => typeof e.ts === "string" && e.ts >= since);
      if (agentEdits.length === 0) return settle("no-agent-edits");
    }
  }
  // Tiny diffs are judged, so the log and the debris list exist, but the
  // verdict carries a reason never to open a popup for it.
  const changedLines = kept.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0);
  const hasNewFile = kept.some((f) => f.status === "A");
  const notifyOnly = changedLines <= config.tinyLines && !hasNewFile ? "tiny" : null;

  const prompts = (state.prompts ?? []).map((p) => p.text).slice(-16);
  const rules = collectRules(root, { max: config.maxRules, home: config.home }).map((r) => r.text);
  const debrisCandidates = candidates(judgedSet);

  let judged;
  try {
    judged = await judgeAll({ config, key, files: judgedSet, prompts, rules, candidates: debrisCandidates });
  } catch (error) {
    log(config, ["judge", config.mode, "error", root, error?.message ?? String(error)]);
    return { outcome: "error", root, error };
  }

  const verdict = composeVerdict({
    config,
    judged,
    root,
    baseline: state.baseline,
    tree,
    session: findSession(args.session),
    reason: args.reason,
    prompts,
    skipped,
    unjudged,
    notifyOnly,
  });
  // The tree may have moved while Jev was thinking.
  const after = snapshotTree(root);
  verdict.stale = after !== tree;

  writeVerdict(config, root, verdict);
  writeState(config, root, { ...readState(config, root), last_judged_tree: tree });
  try {
    writeJsonAtomic(join(repoDir(config, root), "last-request.json"), judged.requests);
  } catch {
    // debug aid only
  }
  const latency = judged.requests.reduce((n, r) => n + (r.result.latency_ms ?? 0), 0);
  log(config, ["judge", config.mode, "verdict", root, verdict.id, verdict.look.verdict, verdict.look.p_ok, `${verdict.files.length} files`, `${verdict.debris.length} debris`, `${latency}ms`]);
  return { outcome: "verdict", root, verdict };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  judge(parseArgs(process.argv.slice(2)))
    .then((r) => {
      if (process.env.JEV_LENS_VERBOSE) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    })
    .catch((error) => {
      try {
        log(readConfig(), ["judge", "?", "crash", String(error?.stack ?? error)]);
      } catch {
        // nothing left to do
      }
    });
}
