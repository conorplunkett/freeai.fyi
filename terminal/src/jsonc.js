export function stripJsonc(src) {
  let out = "";
  let ctx = "code";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const n = src[i + 1];
    if (ctx === "code") {
      if (c === '"') { ctx = "str"; out += c; i++; continue; }
      if (c === "/" && n === "/") { ctx = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { ctx = "block"; i += 2; continue; }
      out += c; i++; continue;
    }
    if (ctx === "str") {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') ctx = "code";
      i++; continue;
    }
    if (ctx === "line") {
      if (c === "\n") { ctx = "code"; out += c; }
      i++; continue;
    }
    if (c === "*" && n === "/") { ctx = "code"; i += 2; continue; }
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(src) {
  return JSON.parse(stripJsonc(src));
}
