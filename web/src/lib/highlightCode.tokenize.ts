import type { HighlighterCore } from "shiki/core";
import { codeLanguage, boundedCode, type CodeToken } from "./highlightCode.shared";

// Explicit imports keep the browser build to this subset. No full bundle, CDN,
// grammar, theme or engine is loaded until a supported, bounded fence needs it.
const languages = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};
type Language = keyof typeof languages;

let highlighter: Promise<HighlighterCore> | undefined;
const loadingLanguages = new Map<Language, Promise<void>>();

function getHighlighter() {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    createHighlighterCore({ engine: createJavaScriptRegexEngine(), themes: [light, dark], langs: [] }),
  ).catch((error: unknown) => { highlighter = undefined; throw error; });
  return highlighter;
}

/** Best-effort enhancement. Plain source is always the authoritative content. */
export async function tokenizeCode(source: string, tag: string): Promise<CodeToken[] | null> {
  const language = codeLanguage(tag);
  if (!language || !boundedCode(source)) return null;
  try {
    const instance = await getHighlighter();
    let loading = loadingLanguages.get(language);
    if (!loading) {
      loading = instance.loadLanguage(languages[language]()).catch((error: unknown) => {
        loadingLanguages.delete(language);
        throw error;
      });
      loadingLanguages.set(language, loading);
    }
    await loading;
    const lines = instance.codeToTokensWithThemes(source, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      // Run to completion off the UI thread. TextMate silently returns partial
      // colors when its per-line deadline expires (including cold compilation).
      // The owner can actually interrupt a stuck worker using terminate().
      tokenizeTimeLimit: 0,
    });
    const result: CodeToken[] = [];
    let offset = 0;
    for (const line of lines) for (const token of line) {
      // Retain separators from the original source, including CRLF and terminal
      // blank lines. Never rebuild source by joining Shiki's normalized lines.
      if (token.offset < offset || source.slice(token.offset, token.offset + token.content.length) !== token.content) return null;
      if (token.offset > offset) result.push({ text: source.slice(offset, token.offset) });
      if (token.content) result.push({ text: token.content, light: token.variants.light?.color, dark: token.variants.dark?.color });
      offset = token.offset + token.content.length;
    }
    if (offset < source.length) result.push({ text: source.slice(offset) });
    return result.length <= 5_000 ? result : null;
  } catch {
    return null;
  }
}
