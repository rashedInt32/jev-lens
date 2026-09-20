// Read the proof gate's result for a repo, written by jev-gates at the same
// Stop that spawned this judge. The gate keys the file the way we key repos,
// so the lookup is a path. The two hooks run side by side and the gate makes
// its own request first, so a fresh file may land a second after we look;
// wait a little for one rather than show a stale list.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { repoKey } from "./repo.mjs";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sameRepo(a, b) {
  return typeof a === "string" && typeof b === "string" && (a === b || real(a) === real(b));
}

/** The unproven changes from one gate payload, in the verdict's shape. */
export function unverifiedFrom(payload) {
  if (!payload || !Array.isArray(payload.scored)) return [];
  const risk = payload.thresholds?.risk ?? 0.7;
  const proof = payload.thresholds?.proof ?? 0.3;
  return payload.scored
    .filter((s) => typeof s.risk === "number" && typeof s.proof === "number" && s.risk >= risk && s.proof <= proof)
    .map((s) => ({ file: s.file, line: s.line, kind: s.kind, summary: s.summary, p_risk: round(s.risk), p_evidence: round(s.proof) }));
}

/**
 * The proof result for `root`, or null. A file counts as fresh when it was
 * judged at or after `fresh`; the wait applies only until a fresh one shows
 * up. A stale file still counts when judged after `since` (the baseline),
 * because an unproven change from an earlier stop is still unproven.
 */
export async function readProof(config, root, { fresh, since, waitMs = config.proofWaitMs ?? 3000, step = 250 } = {}) {
  if (!config.proof) return null;
  // No gates data dir means jev-gates has never run here: nothing to wait for.
  if (!existsSync(config.gatesDir)) return null;
  const path = join(config.gatesDir, "proof", `${repoKey(root)}.json`);
  const deadline = Date.now() + waitMs;
  let payload = null;
  for (;;) {
    payload = existsSync(path) ? readJson(path) : null;
    if (payload && !sameRepo(payload.repo, root)) payload = null;
    const at = typeof payload?.judged_at === "string" ? payload.judged_at : "";
    if (payload && fresh && at >= fresh) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, step));
  }
  if (!payload) return null;
  const at = typeof payload.judged_at === "string" ? payload.judged_at : "";
  if (since && at < since) return null;
  return { judged_at: at, session_id: payload.session_id ?? null, decision: payload.decision ?? null, unverified: unverifiedFrom(payload) };
}

function round(n) {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : n;
}
