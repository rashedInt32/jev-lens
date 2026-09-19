import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { judge } from "../bin/judge.mjs";
import { readConfig } from "../lib/jev.mjs";
import { readState, readVerdict, verdictPath, writeState } from "../lib/repo.mjs";
import { agentWrite, git, lensEnv, startMock, tempRepo, write } from "./helpers.mjs";

function setup(mock, extra = {}) {
  const env = lensEnv(mock, extra);
  const config = readConfig(env);
  return { env, config };
}

test("first run creates a baseline and writes no verdict", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo();
  const r = await judge({ cwd: root, reason: "stop" }, config);
  assert.equal(r.outcome, "baseline-created");
  assert.ok(readState(config, root).baseline);
  assert.equal(readVerdict(config, root), null);
  assert.equal(mock.requests.length, 0);
});

test("no diff since baseline: no verdict, no request", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo();
  await judge({ cwd: root }, config);
  const r = await judge({ cwd: root }, config);
  assert.equal(r.outcome, "no-diff");
  assert.equal(mock.requests.length, 0);
});

test("end to end: agent edits, judge writes a verdict in the agreed shape", async (t) => {
  const mock = await startMock((id) => {
    if (id === "look") return 0.93; // needs a look
    if (id === "f0_look") return 0.81;
    if (id === "f0_kind") return "debris";
    if (id === "f0_prompt") return "p0";
    if (id === "f1_look") return 0.12;
    if (id === "f1_kind") return "routine";
    if (/^d\d+$/.test(id)) return 0.92; // every debris candidate is noise
    return undefined;
  });
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "src/app.ts": "export const a = 1;\n", "src/util.ts": "export const u = 1;\n", "CLAUDE.md": "- Never add console.log in src\n" });
  await judge({ cwd: root }, config); // baseline
  writeState(config, root, { ...readState(config, root), prompts: [{ ts: "t", session_id: "s", text: "add a helper to app.ts" }] });
  await agentWrite(config, root, {
    "src/app.ts": "// Grab the value\n// and export it\nexport const a = 1;\nconsole.log(a);\n",
    "src/util.ts": "export const u = 2;\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  const r = await judge({ cwd: root, reason: "stop", session: "nope" }, config);
  assert.equal(r.outcome, "verdict");
  const v = readVerdict(config, root);
  assert.equal(v.version, 1);
  assert.match(v.id, /^[0-9a-f]{16}$/);
  assert.equal(v.repo, root);
  assert.equal(v.reason, "stop");
  assert.equal(v.mode, "active");
  assert.deepEqual(v.summary.skipped, ["pnpm-lock.yaml"]);
  assert.equal(v.summary.files, 2);
  assert.equal(v.look.verdict, "look");
  assert.equal(v.look.p_ok, 0.07);
  assert.equal(v.files[0].path, "src/app.ts");
  assert.equal(v.files[0].flagged, true);
  assert.equal(v.files[0].kind, "debris");
  assert.equal(v.files[0].kind_top, "debris");
  assert.equal(v.files[0].prompt_index, 0);
  assert.deepEqual(v.files[0].debris, { comment: 1, debug: 1 });
  assert.equal(v.files[1].path, "src/util.ts");
  assert.equal(v.files[1].flagged, false);
  assert.equal(v.debris.length, 2);
  assert.deepEqual(v.debris[0].lines, ["// Grab the value", "// and export it"]);
  assert.equal(v.debris[0].line, 1);
  assert.equal(v.debris[0].end_line, 2);
  assert.equal(v.debris[1].kind, "debug");
  assert.equal(v.debris[1].line, 4);
  assert.deepEqual(v.prompts, ["add a helper to app.ts"]);
  assert.equal(v.reviewed, false);
  assert.equal(v.stale, false);
  assert.equal(v.session.id, "nope");

  // Two calls: files and debris. Rules from CLAUDE.md are in the file call.
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.requests[0].state.rules, ["Never add console.log in src"]);
  assert.equal(Object.keys(mock.requests[0].questions).length, 1 + 2 * 3);
  assert.equal(Object.keys(mock.requests[1].questions).length, 2);
  assert.equal(readState(config, root).last_judged_tree, v.tree);

  // Same tree again coalesces.
  const again = await judge({ cwd: root }, config);
  assert.equal(again.outcome, "coalesced");
  assert.equal(mock.requests.length, 2);
});

test("low kind confidence shows unsure but keeps the top pick; data dir inside the repo is skipped", async (t) => {
  const mock = await startMock((id) => (id === "f0_kind" ? { choice: "behavior_change", confidence: 0.4 } : undefined));
  t.after(() => mock.close());
  const root = tempRepo({ "a.ts": "1\n" });
  // Give the data dir through the symlinked tmp path so the real-path compare is exercised.
  const viaTmp = root.replace(/^\/private\//, "/");
  const config = readConfig(lensEnv(mock, { JEV_LENS_DIR: `${viaTmp}/.lens` }));
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  const outcome = await judge({ cwd: root }, config);
  assert.equal(outcome.outcome, "verdict", JSON.stringify(outcome));
  const v = readVerdict(config, root);
  assert.equal(v.files.length, 1);
  assert.equal(v.files[0].kind, "unsure");
  assert.equal(v.files[0].kind_top, "behavior_change");
  assert.ok(v.summary.skipped.every((p) => p.startsWith(".lens/")));
});

test("green verdict when nothing needs a look; unsure band in between", async (t) => {
  const mock = await startMock((id) => (id === "look" ? 0.05 : id.endsWith("_look") ? 0.05 : undefined));
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  await judge({ cwd: root }, config);
  assert.equal(readVerdict(config, root).look.verdict, "ok");

  mock.state.plan = (id) => (id === "look" ? 0.25 : undefined);
  await agentWrite(config, root, { "a.ts": "3\n" });
  await judge({ cwd: root }, config);
  assert.equal(readVerdict(config, root).look.verdict, "unsure");
});

test("a clean commit resets the baseline and clears the verdict", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  await judge({ cwd: root }, config);
  assert.ok(existsSync(verdictPath(config, root)));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "done");
  const r = await judge({ cwd: root }, config);
  assert.equal(r.outcome, "baseline-commit-clean");
  assert.equal(existsSync(verdictPath(config, root)), false);
  assert.equal(readState(config, root).baseline_reason, "commit-clean");
});

test("--reviewed moves the baseline to now and marks the verdict reviewed", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  await judge({ cwd: root }, config);
  const v = readVerdict(config, root);
  const r = await judge({ cwd: root, reviewed: true }, config);
  assert.equal(r.outcome, "reviewed");
  assert.equal(readState(config, root).baseline, v.tree);
  assert.equal(readState(config, root).reviewed_id, v.id);
  assert.equal(readVerdict(config, root).reviewed, true);
  const next = await judge({ cwd: root }, config);
  assert.equal(next.outcome, "no-diff");
});

test("API failure writes no verdict and logs; shadow mode still writes verdicts", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  mock.state.status = 500;
  const r = await judge({ cwd: root }, config);
  assert.equal(r.outcome, "error");
  assert.equal(readVerdict(config, root), null);
  mock.state.status = 200;
  const shadow = readConfig({ ...lensEnv(mock), JEV_LENS_DIR: config.dataDir, JEV_LENS: "shadow" });
  const s = await judge({ cwd: root }, shadow);
  assert.equal(s.outcome, "verdict");
  assert.equal(readVerdict(config, root).mode, "shadow");
});

test("no key: nothing written, outcome no-key; not a repo: no-repo", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  delete env.TYPESAFE_API_KEY;
  const config = readConfig({ ...env, JEV_KEY_FILE: "/nonexistent" });
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "2\n" });
  assert.equal((await judge({ cwd: root }, config)).outcome, "no-key");
  assert.equal((await judge({ cwd: "/tmp" }, config)).outcome, "no-repo");
});

test("gates before Jev: whitespace-only, comment removal, no agent edits", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "const a = 1;\n// doc\nexport { a };\n", "b.py": "x = 1\n# note\n" });
  await judge({ cwd: root }, config);

  // Formatter run: same tokens, different whitespace.
  await agentWrite(config, root, { "a.ts": "const a=1;\n// doc\nexport {a};\n" });
  assert.equal((await judge({ cwd: root }, config)).outcome, "whitespace-only");
  assert.equal(readVerdict(config, root), null);
  assert.equal(mock.requests.length, 0);

  // Only comment lines removed, in two languages.
  await agentWrite(config, root, { "a.ts": "const a = 1;\nexport { a };\n", "b.py": "x = 1\n" });
  assert.equal((await judge({ cwd: root }, config)).outcome, "comment-removal-only");
  assert.equal(mock.requests.length, 0);

  // A comment ADDED is debris and must be judged.
  await agentWrite(config, root, { "a.ts": "// obvious\nconst a = 1;\nexport { a };\n" });
  assert.equal((await judge({ cwd: root }, config)).outcome, "verdict");
  assert.equal(mock.requests.length, 2);

  // Human typing with no edit on record since the baseline is skipped.
  await judge({ cwd: root, reviewed: true }, config);
  write(root, { "a.ts": "// obvious\nconst a = 2;\nexport { a };\n" });
  assert.equal((await judge({ cwd: root }, config)).outcome, "no-agent-edits");
  assert.equal(mock.requests.length, 2);
  // Unless the gate is switched off.
  const lax = readConfig({ ...lensEnv(mock), JEV_LENS_DIR: config.dataDir, JEV_LENS_REQUIRE_EDITS: "0" });
  assert.equal((await judge({ cwd: root }, lax)).outcome, "verdict");
});

test("tiny diffs are judged but marked notify-only; new files never are", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n2\n3\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "1\n2\nthree\n" });
  await judge({ cwd: root }, config);
  assert.equal(readVerdict(config, root).notify_only, "tiny");
  await judge({ cwd: root, reviewed: true }, config);
  await agentWrite(config, root, { "new.ts": "x\n" });
  await judge({ cwd: root }, config);
  assert.equal(readVerdict(config, root).notify_only, null);
});

test("with no prompt on record, out_of_scope is not offered as a category", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { config } = setup(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  await judge({ cwd: root }, config);
  await agentWrite(config, root, { "a.ts": "1\n2\n3\n4\n5\n" });
  await judge({ cwd: root }, config);
  const kinds = Object.keys(mock.requests[0].questions.f0_kind.criteria);
  assert.ok(!kinds.includes("out_of_scope"), kinds.join(","));
  assert.equal(mock.requests[0].questions.f0_prompt, undefined);
});
