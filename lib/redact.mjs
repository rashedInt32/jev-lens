// What may leave the machine. Two layers: an ignore list of paths that are
// never sent, and a redaction pass over the text that is.

const KEY_SHAPES = [
  /\b(sk|ts|ghp|gho|ghu|ghs|glpat|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:key|token|secret|password|passwd|pwd|api[_-]?key|auth)\b(\s*[=:]\s*['"]?)([A-Za-z0-9+/=_.-]{16,})/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace key-shaped strings with a marker. Idempotent. */
export function redact(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  out = out.replace(KEY_SHAPES[0], "[redacted]");
  out = out.replace(KEY_SHAPES[1], "[redacted]");
  out = out.replace(KEY_SHAPES[2], (m, _sep, value) => m.slice(0, m.length - value.length) + "[redacted]");
  out = out.replace(KEY_SHAPES[3], "[redacted]");
  out = out.replace(KEY_SHAPES[4], "[redacted private key]");
  return out;
}

/** Minimal glob: `*` within a segment, `**` across segments, anchored to path end or any dir. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Match the whole path, or any trailing path segment sequence.
  return new RegExp(`(^|/)${re}$`);
}

/** True when the path matches any glob in the ignore list. */
export function isIgnored(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path) || (g.endsWith("/**") && globToRegExp(g.slice(0, -3)).test(path.split("/").slice(0, -1).join("/"))));
}
