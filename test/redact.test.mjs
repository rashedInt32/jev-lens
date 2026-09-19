import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../lib/jev.mjs";
import { isIgnored, redact } from "../lib/redact.mjs";

test("redact hides key-shaped strings and leaves code alone", () => {
  assert.equal(redact("const k = 'sk-abcdefghijklmnopqrstuvwxyz123456';"), "const k = '[redacted]';");
  assert.equal(redact("TYPESAFE_API_KEY=ts_1234567890abcdefghij"), "TYPESAFE_API_KEY=[redacted]");
  assert.equal(redact("aws: AKIAIOSFODNN7EXAMPLE"), "aws: [redacted]");
  assert.match(redact('password: "correct-horse-battery-staple-99"'), /password: "\[redacted\]/);
  assert.equal(redact("const total = a + b;"), "const total = a + b;");
  assert.match(redact("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), /\[redacted private key\]/);
});

test("default ignore list covers lockfiles, build output, and the secret family", () => {
  const { ignore } = readConfig({});
  for (const p of ["pnpm-lock.yaml", "yarn.lock", "packages/a/Cargo.lock", "dist/index.js", "app/.next/server/x.js", "node_modules/x/y.js", "x.min.js", "a.js.map", ".env", ".env.local", "certs/server.pem", "id_rsa", ".ssh/config", "config/credentials.json", "secrets/prod.yaml"]) {
    assert.equal(isIgnored(p, ignore), true, p);
  }
  for (const p of ["src/app.ts", "package.json", "README.md", "lib/lock.ts", "env.ts", "distribution/x.js"]) {
    assert.equal(isIgnored(p, ignore), false, p);
  }
});

test("JEV_LENS_IGNORE adds globs", () => {
  const { ignore } = readConfig({ JEV_LENS_IGNORE: "generated/**:*.gen.ts" });
  assert.equal(isIgnored("generated/a.ts", ignore), true);
  assert.equal(isIgnored("src/a.gen.ts", ignore), true);
});
