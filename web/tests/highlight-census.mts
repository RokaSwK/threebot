// Run from web: node tests/highlight-census.mts > ../.research/highlight-census.jsonl
// Shared premise under test: a synchronous per-line deadline both protects the
// UI and reliably colors short code despite cold regex compilation/contention.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const examples = [
  ["javascript", 'const answer = "雪";'], ["typescript", "const count: number = 42;"],
  ["jsx", 'const view = <div title="hi">雪</div>;'], ["tsx", 'const view = <div title="hi">雪</div>;'],
  ["json", '{"answer": 42}'], ["python", "def hello():\n    return 42"],
  ["shellscript", 'echo "hello"'], ["html", '<div class="hello">雪</div>'],
  ["css", ".hello { color: red; }"], ["sql", "SELECT answer FROM examples;"], ["yaml", "answer: true"],
];
const [mode, engineName, limitText, actor, onlyLanguage] = process.argv.slice(2);
if (!mode) {
  const child = (...args: string[]) => new Promise<void>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: ["ignore", "inherit", "inherit"] });
    process.on("error", reject);
    process.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`census exit ${code}`)));
  });
  for (const engine of ["javascript", "oniguruma"]) for (const limit of ["500", "0"]) {
    for (const [language] of examples) await child("isolated", engine, limit, "alone", language);
    await child("shared", engine, limit, "alone");
    const concurrency = Number(process.env.HIGHLIGHT_CENSUS_CONCURRENCY ?? 32);
    await Promise.all(Array.from({ length: concurrency }, (_, index) => child("shared", engine, limit, `concurrent-${index}`, "shell-first")));
  }
} else {
  const { createHighlighterCore } = await import("shiki/core");
  const engine = engineName === "javascript"
    ? (await import("shiki/engine/javascript")).createJavaScriptRegexEngine()
    : (await import("shiki/engine/oniguruma")).createOnigurumaEngine(import("shiki/wasm"));
  const themes = await Promise.all([import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")]);
  const create = () => createHighlighterCore({ engine, themes, langs: [] });
  const shared = mode === "shared" ? await create() : null;
  const grammars = mode === "shared" ? await Promise.all(examples.map(([language]) => import(`shiki/langs/${language}.mjs`))) : [];
  const sharedLoadStart = performance.now();
  if (shared) await Promise.all(grammars.map((grammar) => shared.loadLanguage(grammar)));
  const sharedLoadMs = performance.now() - sharedLoadStart;
  const selected = mode === "isolated" ? examples.filter(([language]) => language === onlyLanguage)
    : onlyLanguage === "shell-first" ? examples.toSorted(([a], [b]) => Number(b === "shellscript") - Number(a === "shellscript")) : examples;
  for (const [language, source] of selected) {
    const highlighter = shared ?? await create();
    const loadStart = performance.now();
    if (!shared) await highlighter.loadLanguage(await import(`shiki/langs/${language}.mjs`));
    const loadMs = shared ? sharedLoadMs : performance.now() - loadStart;
    for (const state of ["cold", "warm"]) {
      const start = performance.now();
      const lines = highlighter.codeToTokensWithThemes(source, {
        lang: language, themes: { light: "github-light", dark: "github-dark" }, tokenizeTimeLimit: Number(limitText),
      });
      const tokens = lines.flat();
      console.log(JSON.stringify({ mode, engine: engineName, limit: Number(limitText), actor, language, state,
        loadMs: Math.round(loadMs), tokenMs: Math.round(performance.now() - start), tokens: tokens.length,
        colors: new Set(tokens.map((token) => token.variants.light?.color)).size,
        exact: tokens.map((token) => token.content).join("") === source.replaceAll("\n", ""),
        // Keep actual token results so partial first-line coloring is inspectable.
        result: tokens.map((token) => [token.content, token.variants.light?.color]),
      }));
    }
    if (!shared) highlighter.dispose();
  }
  shared?.dispose();
}
