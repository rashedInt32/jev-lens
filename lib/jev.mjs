// Shared plumbing: config, key lookup, one Jev request with answer validation,
// decision log. Borrowed from jev-gates and trimmed to what the lens needs.
//
// Every failure path is designed to be caught by the caller and turned into
// "no verdict". A judge that cannot reach Jev writes nothing. Silence is never
// green.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MODES = new Set(["off", "shadow", "active"]);

const DEFAULT_IGNORE = [
  "*lock*.json", "*.lock", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum",
  "dist/**", "build/**", ".next/**", "node_modules/**", "*.min.*", "*.map", "*.snap",
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_*", ".ssh/**", ".aws/**",
  ".kube/**", "credentials*", "secrets/**",
  // Generated output a test or build run leaves behind.
  "coverage/**", ".nyc_output/**", ".turbo/**", ".cache/**", "tmp/**", "*.log", ".DS_Store", "*.tsbuildinfo",
];

/** Read the lens configuration from the environment. */
export function readConfig(env = process.env) {
  const mode = MODES.has(env.JEV_LENS) ? env.JEV_LENS : "active";
  return {
    mode,
    model: env.JEV_LENS_MODEL || "jev-latest",
    baseUrl: env.JEV_LENS_BASE_URL || "https://api.typesafe.ai/v1/systemone",
    timeoutMs: positive(env.JEV_LENS_TIMEOUT_MS, 15_000),
    maxChars: positive(env.JEV_LENS_MAX_CHARS, 40_000),
    maxFiles: positive(env.JEV_LENS_MAX_FILES, 40),
    maxRules: positive(env.JEV_LENS_MAX_RULES, 32),
    green: unit(env.JEV_LENS_GREEN, 0.9),
    unsure: unit(env.JEV_LENS_UNSURE, 0.6),
    fileThreshold: unit(env.JEV_LENS_FILE_THRESHOLD, 0.6),
    kindConfidence: unit(env.JEV_LENS_KIND_CONFIDENCE, 0.7),
    debrisThreshold: unit(env.JEV_LENS_DEBRIS_THRESHOLD, 0.7),
    // A diff at or under this many changed lines (and no new file) is judged
    // but never opens a popup.
    tinyLines: positive(env.JEV_LENS_TINY_LINES, 3),
    // Skip judging when the edit log shows no agent edit since the baseline:
    // the diff is the human's own typing. JEV_LENS_REQUIRE_EDITS=0 disables.
    requireEdits: env.JEV_LENS_REQUIRE_EDITS !== "0",
    ignore: [...DEFAULT_IGNORE, ...(env.JEV_LENS_IGNORE ? env.JEV_LENS_IGNORE.split(":").filter(Boolean) : [])],
    home: env.HOME || homedir(),
    dataDir: env.JEV_LENS_DIR || join(homedir(), ".claude", "jev-lens"),
    // The jev-gates data dir, where the proof gate leaves its per-repo result.
    // JEV_LENS_PROOF=0 stops the judge from reading it.
    gatesDir: env.JEV_GATES_DIR || join(homedir(), ".claude", "jev-gates"),
    proof: env.JEV_LENS_PROOF !== "0",
    proofWaitMs: positive(env.JEV_LENS_PROOF_WAIT_MS, 3000),
    keyFile: env.JEV_KEY_FILE || join(homedir(), ".config", "typesafe", "key"),
    // Captured here so a config built from a custom env never falls back to
    // the process environment.
    apiKey: env.TYPESAFE_API_KEY || env.JEV_API_KEY || undefined,
  };
}

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function unit(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** The key comes from the environment or a 0600 file. Never from arguments. */
export function readKey(config) {
  if (config.apiKey) return config.apiKey;
  try {
    const contents = readFileSync(config.keyFile, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/** Read all of stdin as JSON, or return undefined when nothing usable arrives. */
export async function readStdinJson(timeoutMs = 3000) {
  const chunks = [];
  // unref: the timer must not keep a finished hook alive for the full timeout.
  const timer = new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs).unref());
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  })();
  const raw = await Promise.race([read, timer]);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A yes/no question with explicit meanings for both outcomes. */
export function noul(instructions, yesMeans, noMeans) {
  return { type: "noul", instructions, criteria: { true: yesMeans, false: noMeans } };
}

/** A pick-one question over options the caller defines. */
export function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

function isUnit(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Validate one answer against the question sent; throws on any mismatch. */
function validateAnswer(id, question, answer) {
  if (question.type === "noul") {
    if (!isUnit(answer?.noul)) throw new Error(`Malformed answer for '${id}'`);
    return answer.noul;
  }
  const keys = Object.keys(question.criteria);
  const probs = answer?.probabilities;
  if (typeof answer?.choice !== "string" || !keys.includes(answer.choice) || !isUnit(answer.confidence)) {
    throw new Error(`Malformed answer for '${id}'`);
  }
  if (!probs || Object.keys(probs).length !== keys.length || !keys.every((k) => isUnit(probs[k]))) {
    throw new Error(`Malformed distribution for '${id}'`);
  }
  const sum = keys.reduce((acc, k) => acc + probs[k], 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error(`Malformed distribution for '${id}'`);
  return { choice: answer.choice, confidence: answer.confidence, probabilities: probs };
}

/**
 * One System One request. Returns validated answers keyed by question id,
 * plus latency and usage. Throws on any transport or shape error.
 */
export async function ask({ config, key, state, questions }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = performance.now();
  let response;
  try {
    response = await fetch(config.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const latency_ms = Math.round(performance.now() - started);
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}`);
  const body = await response.json();
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = validateAnswer(id, question, body?.answers?.[id]);
  }
  return { answers, latency_ms, usage: body.usage ?? {}, model: body.model };
}

// ── Files, log ──────────────────────────────────────────────────────────────

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best effort
  }
}

/** Write JSON through a temp file and rename, so readers never see a torn file. */
export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** Append one tab-separated line. Field order is fixed so the log is greppable. */
export function log(config, fields) {
  try {
    ensureDir(config.dataDir);
    const line = [new Date().toISOString(), ...fields.map((f) => String(f ?? "").replace(/[\t\n\r]+/g, " "))].join("\t");
    appendFileSync(join(config.dataDir, "decisions.log"), line + "\n");
  } catch {
    // never let logging break the judge
  }
}

/** Bound a string; the caller decides whether a truncated state is acceptable. */
export function clip(text, max) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : text.slice(0, max) + `\n[… ${text.length - max} more characters …]`;
}
