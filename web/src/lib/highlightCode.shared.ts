export function codeLanguage(tag: string) {
  switch (tag.toLowerCase()) {
    case "js": case "javascript": return "javascript";
    case "ts": case "typescript": return "typescript";
    case "jsx": return "jsx";
    case "tsx": return "tsx";
    case "json": return "json";
    case "py": case "python": return "python";
    case "sh": case "shell": case "bash": case "shellscript": return "shellscript";
    case "html": return "html";
    case "css": return "css";
    case "sql": return "sql";
    case "yml": case "yaml": return "yaml";
    default: return null;
  }
}

export function boundedCode(source: string) {
  if (!source || source.length > 20_000) return false;
  const lines = source.split(/\r\n|\r|\n/);
  return lines.length <= 500 && lines.every((line) => line.length <= 2_000);
}

export type CodeToken = { text: string; light?: string; dark?: string };
export type HighlightRequest = { id: number; source: string; language: NonNullable<ReturnType<typeof codeLanguage>> };

/** The worker boundary must never introduce text that wasn't in the source. */
export function readTokens(value: unknown, source: string): CodeToken[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null;
  const tokens: CodeToken[] = [];
  let offset = 0;
  const entries: readonly unknown[] = value;
  for (const token of entries) {
    if (!token || typeof token !== "object" || !("text" in token) || typeof token.text !== "string") return null;
    const light = "light" in token ? token.light : undefined;
    const dark = "dark" in token ? token.dark : undefined;
    if (light !== undefined && (typeof light !== "string" || !/^#[0-9a-f]{6,8}$/i.test(light))) return null;
    if (dark !== undefined && (typeof dark !== "string" || !/^#[0-9a-f]{6,8}$/i.test(dark))) return null;
    if (source.slice(offset, offset + token.text.length) !== token.text) return null;
    offset += token.text.length;
    tokens.push({ text: token.text, light, dark });
  }
  return offset === source.length ? tokens : null;
}
