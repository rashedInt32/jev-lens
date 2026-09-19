// Test rig: a stand-in TypeSafe API, throwaway git repos, and a runner that
// drives a hook script over stdin exactly the way Claude Code does.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Start a stand-in API. `plan(id, question)` returns the probability for a
 * noul question (default 0.05), or the chosen key for a choice question
 * (default: the first option). Every request body is recorded.
 */
export async function startMock(plan = () => undefined) {
  const requests = [];
  const state = { status: 200, plan };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (state.status !== 200) {
        res.writeHead(state.status);
        res.end(JSON.stringify({ error: { message: "mock failure" } }));
        return;
      }
      const answers = {};
      for (const [id, q] of Object.entries(body.questions ?? {})) {
        const planned = state.plan(id, q);
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: typeof planned === "number" ? planned : 0.05 };
        } else {
          const keys = Object.keys(q.criteria);
          const pick = typeof planned === "string" && keys.includes(planned) ? planned : keys[0];
          const conf = typeof planned === "object" && planned ? planned.confidence : 0.9;
          const choice = typeof planned === "object" && planned ? planned.choice : pick;
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? conf : (1 - conf) / (keys.length - 1)]));
          answers[id] = { type: "choice", choice, confidence: conf, probabilities };
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ model: "mock-jev", answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function tempDir(prefix = "jev-lens-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
}

/** A fresh git repo with one commit holding the given files. */
export function tempRepo(files = { "README.md": "# hi\n" }) {
  // git reports the real path (/private/var on macOS), so tests must too.
  const root = realpathSync(tempDir("repo-"));
  git(root, "init", "-q", "-b", "main");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

export function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** Run a hook script with a JSON payload on stdin. */
export function runHook(script, input, env = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [join(ROOT, "hooks", script)], {
      env: { PATH: process.env.PATH, HOME: env.HOME ?? tempDir("home-"), JEV_KEY_FILE: "/nonexistent/jev-lens/key", ...GIT_ENV, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

export const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

/** Environment for a judge run against a mock, with isolated data and home. */
export function lensEnv(mock, extra = {}) {
  return { [KEY_VAR]: "k", JEV_LENS_BASE_URL: mock.url, JEV_LENS_DIR: tempDir("data-"), HOME: tempDir("home-"), ...extra };
}

/** Record agent edits for `files` in the repo's state, the way the PostToolUse hook does. */
export async function markEdits(config, root, files) {
  const { readState, writeState } = await import("../lib/repo.mjs");
  const state = readState(config, root) ?? {};
  const ts = new Date(Date.now() + 5).toISOString();
  const edits = [...(state.edits ?? []), ...Object.keys(files).map((file) => ({ ts, session_id: "s", file, tool: "Edit" }))];
  writeState(config, root, { ...state, edits });
}

/** Write files as the agent would: on disk plus an edit-log entry. */
export async function agentWrite(config, root, files) {
  write(root, files);
  await markEdits(config, root, files);
}

/** Wait until `fn()` is truthy or the timeout passes. */
export async function until(fn, { timeout = 5000, step = 50 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
}
