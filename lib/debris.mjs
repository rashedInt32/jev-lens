// Debris candidates: things an agent leaves behind that a human usually
// deletes. Found by regex over the added lines of a patch, then judged by Jev.
// Code enumerates, Jev selects. Nothing here decides on its own.

const LINE_COMMENT = {
  slash: /^\s*\/\/(?!\/)/, // // but not ///
  hash: /^\s*#(?!!)/, // # but not shebang
  dash: /^\s*--/,
  html: /^\s*<!--.*-->\s*$/,
};

const BLOCK_ONLY = {
  slash: /^\s*(\/\*.*\*\/|\/\*.*|\*.*|.*\*\/)\s*$/,
};

/** Comment syntax family by file extension. */
export function commentFamily(path) {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "go", "rs", "java", "kt", "kts", "scala", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "css", "scss", "less", "php", "dart", "zig"].includes(ext)) return "slash";
  if (["py", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "pl", "r", "ex", "exs", "nix", "conf", "ini", "dockerfile", "makefile"].includes(ext)) return "hash";
  if (["lua", "sql", "hs", "elm"].includes(ext)) return "dash";
  if (["html", "vue", "svelte", "xml", "md", "mdx"].includes(ext)) return "html";
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base === "makefile") return "hash";
  return null;
}

const DEBUG = /\b(console\.(log|debug|info|trace|dir)|print\(|pprint\(|fmt\.Print(ln|f)?\(|dbg!\(|debugger;?|binding\.pry|byebug|var_dump\(|System\.out\.print)/;
const TODO = /\b(TODO|FIXME|XXX|HACK)\b/;
const SUPPRESSION = /(eslint-disable|@ts-ignore|@ts-expect-error|#\s*noqa|#\s*type:\s*ignore|#\s*nosec|\/\/\s*nolint|@SuppressWarnings|#\s*pragma:\s*no cover|\/\/\s*@ts-nocheck|# rubocop:disable)/;
const ANY_CAST = /(\bas\s+any\b|:\s*any\b|<any>)/;

/** Added lines from a unified patch with their new-file line numbers. */
export function addedLines(patch) {
  const out = [];
  if (!patch) return out;
  let line = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // removed line or "no newline" marker: new-file line number unchanged
    } else {
      line += 1;
    }
  }
  return out;
}

export function isCommentOnly(text, family) {
  if (!family) return false;
  if (!text.trim()) return false;
  if (LINE_COMMENT[family]?.test(text)) return true;
  if (family === "slash" && BLOCK_ONLY.slash.test(text)) return true;
  return false;
}

/** Removed lines from a unified patch (text only; old-file numbers unused). */
export function removedLines(patch) {
  const out = [];
  if (!patch) return out;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("-") && !raw.startsWith("---")) out.push(raw.slice(1));
  }
  return out;
}

/**
 * True when every file only lost comment lines: nothing added anywhere, and
 * every removed line is comment-only in that file's syntax. Deleting a doc
 * comment has no behavior effect and nothing to strip, so it is not worth a
 * judgment. Added comments are debris candidates and never qualify.
 */
export function commentRemovalOnly(files) {
  if (files.length === 0) return false;
  for (const f of files) {
    if (f.binary || !f.patch) return false;
    const family = commentFamily(f.path);
    if (!family) return false;
    if (addedLines(f.patch).length > 0) return false;
    const removed = removedLines(f.patch);
    if (removed.length === 0) return false;
    if (!removed.every((line) => isCommentOnly(line, family) || !line.trim())) return false;
  }
  return true;
}

/**
 * Candidates for one file: `{file, kind, line, end_line, lines}`. Consecutive
 * comment-only lines become one block; other classes are single lines.
 */
export function candidatesFor(path, patch) {
  const family = commentFamily(path);
  const isTs = /\.(ts|tsx|mts|cts)$/.test(path);
  const added = addedLines(patch);
  const out = [];
  let block = null;
  const flush = () => {
    if (block) out.push(block);
    block = null;
  };
  for (const { line, text } of added) {
    const comment = isCommentOnly(text, family);
    if (comment) {
      // A comment carrying a suppression or TODO marker is that class alone.
      // One candidate per line, so stripping never deletes a line twice.
      if (SUPPRESSION.test(text) || TODO.test(text)) {
        flush();
        out.push({ file: path, kind: SUPPRESSION.test(text) ? "suppression" : "todo", line, end_line: line, lines: [text] });
        continue;
      }
      if (block && block.end_line === line - 1) {
        block.end_line = line;
        block.lines.push(text);
      } else {
        flush();
        block = { file: path, kind: "comment", line, end_line: line, lines: [text] };
      }
      continue;
    }
    flush();
    if (SUPPRESSION.test(text)) out.push({ file: path, kind: "suppression", line, end_line: line, lines: [text] });
    else if (DEBUG.test(text)) out.push({ file: path, kind: "debug", line, end_line: line, lines: [text] });
    else if (TODO.test(text)) out.push({ file: path, kind: "todo", line, end_line: line, lines: [text] });
    else if (isTs && ANY_CAST.test(text)) out.push({ file: path, kind: "any_cast", line, end_line: line, lines: [text] });
  }
  flush();
  return out.sort((a, b) => a.line - b.line);
}

/** Candidates across files, capped, with a stable id each. */
export function candidates(files, { max = 256 } = {}) {
  const all = [];
  for (const f of files) {
    if (f.binary || !f.patch) continue;
    for (const c of candidatesFor(f.path, f.patch)) {
      all.push({ id: `d${all.length}`, ...c });
      if (all.length >= max) return all;
    }
  }
  return all;
}

export const KIND_LABEL = {
  comment: "comment",
  debug: "debug print",
  todo: "TODO marker",
  suppression: "lint or type suppression",
  any_cast: "TypeScript any",
};
