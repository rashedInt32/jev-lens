import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, candidates, candidatesFor, commentFamily } from "../lib/debris.mjs";

const patch = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;

test("addedLines tracks new-file line numbers across hunks", () => {
  const p = "@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10,1 +11,2 @@\n-x\n+y\n+z\n";
  assert.deepEqual(addedLines(p), [
    { line: 2, text: "b" },
    { line: 11, text: "y" },
    { line: 12, text: "z" },
  ]);
});

test("comment family by extension and filename", () => {
  assert.equal(commentFamily("a.ts"), "slash");
  assert.equal(commentFamily("a.py"), "hash");
  assert.equal(commentFamily("a.lua"), "dash");
  assert.equal(commentFamily("a.vue"), "html");
  assert.equal(commentFamily("Dockerfile"), "hash");
  assert.equal(commentFamily("a.bin"), null);
});

test("consecutive comment lines group into one block; a gap splits them", () => {
  const p = "@@ -1,0 +1,5 @@\n+// one\n+// two\n+const x = 1;\n+// three\n+/* four */\n";
  const c = candidatesFor("a.ts", p).filter((d) => d.kind === "comment");
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { file: "a.ts", kind: "comment", line: 1, end_line: 2, lines: ["// one", "// two"] });
  assert.deepEqual(c[1].lines, ["// three", "/* four */"]);
});

test("debug, todo, suppression, any_cast are detected per language", () => {
  const ts = candidatesFor("a.ts", patch(["console.log('x')", "// TODO: later", "// eslint-disable-next-line", "const y = z as any;"]));
  assert.deepEqual(ts.map((d) => d.kind).sort(), ["any_cast", "debug", "suppression", "todo"]);
  const py = candidatesFor("a.py", patch(["print(x)", "x = 1  # noqa", "# FIXME"]));
  assert.deepEqual(py.map((d) => d.kind).sort(), ["debug", "suppression", "todo"]);
  const go = candidatesFor("a.go", patch(["fmt.Println(x)", "//nolint:errcheck"]));
  assert.deepEqual(go.map((d) => d.kind).sort(), ["debug", "suppression"]);
  const lua = candidatesFor("a.lua", patch(["-- helper", "print(x)"]));
  assert.deepEqual(lua.map((d) => d.kind).sort(), ["comment", "debug"]);
  const js = candidatesFor("a.js", patch(["const y = z as any;"]));
  assert.equal(js.length, 0, "any_cast only in TypeScript");
});

test("shebang and doc-comment triple slash are not comment debris", () => {
  const sh = candidatesFor("run.sh", patch(["#!/usr/bin/env bash", "# real comment"]));
  assert.equal(sh.length, 1);
  assert.equal(sh[0].line, 2);
  const ts = candidatesFor("a.ts", patch(["/// <reference types='node' />"]));
  assert.equal(ts.length, 0);
});

test("one candidate per line: a suppression comment is not also a comment block", () => {
  const c = candidatesFor("a.ts", patch(["// one", "// eslint-disable-next-line", "// two"]));
  assert.deepEqual(c.map((d) => [d.kind, d.line, d.end_line]), [["comment", 1, 1], ["suppression", 2, 2], ["comment", 3, 3]]);
  const lines = new Set();
  for (const d of c) for (let l = d.line; l <= d.end_line; l += 1) {
    assert.equal(lines.has(l), false, `line ${l} claimed twice`);
    lines.add(l);
  }
});

test("candidates gets stable ids and skips binaries", () => {
  const files = [
    { path: "a.ts", patch: patch(["// c"]) },
    { path: "b.png", binary: true },
    { path: "c.ts", patch: patch(["debugger;"]) },
  ];
  const all = candidates(files);
  assert.deepEqual(all.map((c) => c.id), ["d0", "d1"]);
  assert.equal(all[1].file, "c.ts");
});
