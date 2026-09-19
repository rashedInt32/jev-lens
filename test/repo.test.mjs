import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../lib/jev.mjs";
import { diffTrees, headTree, isClean, readState, repoKey, repoRoot, snapshotTree, statePath, writeState } from "../lib/repo.mjs";
import { git, tempDir, tempRepo, write } from "./helpers.mjs";

test("repoRoot resolves the toplevel from a subdirectory and null outside git", () => {
  const root = tempRepo({ "a/b/c.txt": "x\n" });
  assert.equal(repoRoot(join(root, "a", "b")), git(root, "rev-parse", "--show-toplevel").trim());
  assert.equal(repoRoot(tempDir("plain-")), null);
});

test("repoKey is 16 hex chars of sha256(root)", () => {
  assert.match(repoKey("/x/y"), /^[0-9a-f]{16}$/);
  assert.equal(repoKey("/x/y"), repoKey("/x/y"));
  assert.notEqual(repoKey("/x/y"), repoKey("/x/z"));
});

test("snapshotTree equals HEAD tree on a clean repo and changes with untracked files", () => {
  const root = tempRepo();
  assert.equal(snapshotTree(root), headTree(root));
  assert.equal(isClean(root), true);
  write(root, { "new.txt": "hello\n" });
  const t = snapshotTree(root);
  assert.notEqual(t, headTree(root));
  assert.equal(isClean(root), false);
  // The real index is untouched by the snapshot.
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "");
});

test("snapshotTree respects .gitignore", () => {
  const root = tempRepo({ ".gitignore": "dist/\n" });
  const before = snapshotTree(root);
  write(root, { "dist/out.js": "x" });
  assert.equal(snapshotTree(root), before);
});

test("diffTrees lists added, modified, deleted files with numstat and patches", () => {
  const root = tempRepo({ "keep.txt": "a\nb\n", "gone.txt": "bye\n" });
  const base = snapshotTree(root);
  write(root, { "keep.txt": "a\nB\nc\n", "new.js": "// hi\nconsole.log(1)\n" });
  git(root, "rm", "-q", "gone.txt");
  const now = snapshotTree(root);
  const files = diffTrees(root, base, now);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ["gone.txt", "keep.txt", "new.js"]);
  assert.equal(byPath["new.js"].status, "A");
  assert.equal(byPath["gone.txt"].status, "D");
  assert.equal(byPath["keep.txt"].status, "M");
  assert.equal(byPath["keep.txt"].added, 2);
  assert.equal(byPath["keep.txt"].removed, 1);
  assert.match(byPath["keep.txt"].patch, /^@@/);
  assert.match(byPath["new.js"].patch, /\+console\.log\(1\)/);
  assert.deepEqual(diffTrees(root, base, base), []);
});

test("state round-trips through an atomic write", () => {
  const config = readConfig({ JEV_LENS_DIR: tempDir("data-") });
  const root = "/some/repo";
  writeState(config, root, { baseline: "abc" });
  const s = readState(config, root);
  assert.equal(s.baseline, "abc");
  assert.equal(s.root, root);
  assert.deepEqual(s.prompts, []);
  assert.equal(JSON.parse(readFileSync(statePath(config, root), "utf8")).version, 1);
});
