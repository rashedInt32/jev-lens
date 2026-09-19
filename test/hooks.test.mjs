import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../lib/jev.mjs";
import { readState, readVerdict } from "../lib/repo.mjs";
import { lensEnv, runHook, startMock, tempRepo, until, write } from "./helpers.mjs";

test("session-start creates a baseline once and never calls the API", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo();
  const r = await runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: root, session_id: "s1" }, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  const config = readConfig(env);
  const first = readState(config, root).baseline;
  await runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: root, session_id: "s1" }, env);
  assert.equal(readState(config, root).baseline, first);
  assert.equal(mock.requests.length, 0);
});

test("prompt-record appends cleaned prompts and skips slash commands", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo();
  const config = readConfig(env);
  await runHook("prompt-record.mjs", { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s1", prompt: "add a helper <system-reminder>x</system-reminder>" }, env);
  await runHook("prompt-record.mjs", { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s1", prompt: "/clear" }, env);
  await runHook("prompt-record.mjs", { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s1", prompt: "ok" }, env);
  const s = readState(config, root);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].text, "add a helper");
  assert.equal(s.prompts[0].session_id, "s1");
});

test("edit-record appends repo-relative files and ignores paths outside the repo", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo();
  const config = readConfig(env);
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Edit", tool_input: { file_path: `${root}/src/a.ts` } }, env);
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Write", tool_input: { file_path: "/elsewhere/b.ts" } }, env);
  const s = readState(config, root);
  assert.deepEqual(s.edits.map((e) => [e.file, e.tool]), [["src/a.ts", "Edit"]]);
});

test("edit-record sees Bash writes through the shell detector", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo();
  const config = readConfig(env);
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Bash", tool_input: { command: "sed -i '' 's/a/b/' src/x.ts && echo hi > notes.md" } }, env);
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Bash", tool_input: { command: "cat src/x.ts | grep a" } }, env);
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Bash", tool_input: { command: "node -e \"require('fs').writeFileSync('out.json','{}')\"" } }, env);
  const files = readState(config, root).edits.map((e) => e.file).sort();
  assert.deepEqual(files, ["(script)", "notes.md", "src/x.ts"]);
});

test("stop-judge returns fast, spawns the judge, and the verdict appears later", async (t) => {
  const mock = await startMock((id) => (id === "look" ? 0.8 : id.endsWith("_look") ? 0.8 : undefined));
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  const config = readConfig(env);
  await runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: root }, env);
  write(root, { "a.ts": "2\n3\n4\n5\n6\n" });
  await runHook("edit-record.mjs", { hook_event_name: "PostToolUse", cwd: root, session_id: "s1", tool_name: "Write", tool_input: { file_path: `${root}/a.ts` } }, env);
  const r = await runHook("stop-judge.mjs", { hook_event_name: "Stop", cwd: root, session_id: "s1", stop_hook_active: false }, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(r.ms < 1500, `stop hook took ${r.ms}ms`);
  const v = await until(() => readVerdict(config, root));
  assert.ok(v, "verdict written by the detached judge");
  assert.equal(v.reason, "stop");
  assert.equal(v.session.id, "s1");
  assert.equal(v.look.verdict, "look");
});

test("stop-judge does nothing on re-entry or when off", async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const env = lensEnv(mock);
  const root = tempRepo({ "a.ts": "1\n" });
  const config = readConfig(env);
  await runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: root }, env);
  write(root, { "a.ts": "2\n" });
  await runHook("stop-judge.mjs", { hook_event_name: "Stop", cwd: root, stop_hook_active: true }, env);
  await runHook("stop-judge.mjs", { hook_event_name: "Stop", cwd: root, stop_hook_active: false }, { ...env, JEV_LENS: "off" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(readVerdict(config, root), null);
  assert.equal(mock.requests.length, 0);
});
