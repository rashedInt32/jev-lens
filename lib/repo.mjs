// Repo state: root and key, the per-repo state file, baseline snapshots as git
// tree objects, and the diff between two trees.
//
// A snapshot is a tree written from a temporary index after `git add -A`, so
// it holds the working tree as git would commit it: untracked files in,
// ignored files out. Two snapshots diff with `git diff-tree`, which is how
// untracked files show up as additions without any stash or commit.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, writeJsonAtomic } from "./jev.mjs";

const GIT_OPTS = { encoding: "utf8", timeout: 8000, maxBuffer: 16_000_000, stdio: ["ignore", "pipe", "ignore"] };

function git(root, args, extraEnv = {}) {
  return execFileSync("git", ["-C", root, ...args], { ...GIT_OPTS, env: { ...process.env, ...extraEnv } });
}

/** Absolute git toplevel for a directory, or null when not inside a repo. */
export function repoRoot(cwd) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch {
    return null;
  }
}

/** Sixteen hex chars of the root's sha256. nvim computes the same. */
export function repoKey(root) {
  return sha256(root).slice(0, 16);
}

export function repoDir(config, root) {
  return join(config.dataDir, "repos", repoKey(root));
}

export function statePath(config, root) {
  return join(repoDir(config, root), "state.json");
}

export function verdictPath(config, root) {
  return join(repoDir(config, root), "verdict.json");
}

export function readState(config, root) {
  try {
    const state = JSON.parse(readFileSync(statePath(config, root), "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

export function writeState(config, root, state) {
  writeJsonAtomic(statePath(config, root), { version: 1, root, prompts: [], edits: [], ...state });
}

export function readVerdict(config, root) {
  try {
    return JSON.parse(readFileSync(verdictPath(config, root), "utf8"));
  } catch {
    return null;
  }
}

export function writeVerdict(config, root, verdict) {
  writeJsonAtomic(verdictPath(config, root), verdict);
}

export function deleteVerdict(config, root) {
  try {
    unlinkSync(verdictPath(config, root));
  } catch {
    // already gone
  }
}

/** Tree oid of HEAD, or null in an unborn repo. */
export function headTree(root) {
  try {
    return git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  } catch {
    return null;
  }
}

/** True when `git status` reports nothing: no changes, no untracked files. */
export function isClean(root) {
  try {
    return git(root, ["status", "--porcelain", "--untracked-files=all"]).trim() === "";
  } catch {
    return false;
  }
}

/**
 * Snapshot the working tree as a tree object and return its oid. Uses a
 * throwaway index so the real index and HEAD are untouched.
 */
export function snapshotTree(root) {
  const dir = mkdtempSync(join(tmpdir(), "jev-lens-index-"));
  const index = join(dir, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = headTree(root);
    if (head) git(root, ["read-tree", head], env);
    git(root, ["add", "-A", "--", "."], env);
    return git(root, ["write-tree"], env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Paths that differ between two trees. No patches, one git call. */
export function changedPaths(root, from, to) {
  if (from === to) return [];
  const out = git(root, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", from, to]);
  return out.split("\0").filter(Boolean);
}

/**
 * Files changed between two trees, with numstat and a unified patch each.
 * Binary files come back with `binary: true` and no patch. `only`, when
 * given, keeps the diff to that set of paths.
 */
export function diffTrees(root, from, to, { context = 3, only = null } = {}) {
  if (from === to) return [];
  const numstat = git(root, ["diff-tree", "-r", "--numstat", "-z", "--no-renames", from, to]);
  const files = [];
  const parts = numstat.split("\0").filter(Boolean);
  for (const part of parts) {
    const [added, removed, path] = part.split("\t");
    if (path === undefined) continue;
    if (only && !only.has(path)) continue;
    files.push({ path, added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), binary: added === "-" });
  }
  const statusRaw = git(root, ["diff-tree", "-r", "--name-status", "-z", "--no-renames", from, to]);
  const statusParts = statusRaw.split("\0").filter(Boolean);
  const status = new Map();
  for (let i = 0; i + 1 < statusParts.length; i += 2) status.set(statusParts[i + 1], statusParts[i][0]);
  for (const f of files) f.status = status.get(f.path) ?? "M";

  for (const f of files) {
    if (f.binary) continue;
    try {
      const patch = git(root, ["diff-tree", "-p", `-U${context}`, "--no-renames", "--no-color", from, to, "--", f.path]);
      f.patch = stripPatchHeader(patch);
    } catch {
      f.patch = "";
    }
  }
  return files;
}

/** Drop the `diff --git` / index / --- / +++ lines; keep from the first hunk. */
function stripPatchHeader(patch) {
  const at = patch.indexOf("\n@@");
  return at === -1 ? "" : patch.slice(at + 1);
}

/**
 * True when at least one of `paths` differs between the trees once
 * whitespace is ignored. A formatter run comes back false.
 */
export function changedIgnoringWhitespace(root, from, to, paths) {
  if (from === to || paths.length === 0) return false;
  const out = git(root, ["diff-tree", "-r", "-w", "--numstat", "-z", "--no-renames", from, to, "--", ...paths]);
  return out
    .split("\0")
    .filter(Boolean)
    .some((part) => {
      const [added, removed] = part.split("\t");
      return added === "-" || Number(added) > 0 || Number(removed) > 0;
    });
}

/** Read one file from a tree, or null when absent. */
export function fileAtTree(root, tree, path) {
  try {
    return git(root, ["show", `${tree}:${path}`]);
  } catch {
    return null;
  }
}

export function repoExists(root) {
  return typeof root === "string" && existsSync(root);
}
