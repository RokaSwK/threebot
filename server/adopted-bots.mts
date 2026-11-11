// Bots made from an existing T3 project ("adopted" Bots). The Bot works in the project's own folder
// and reuses its T3 project, so nothing it adds may show up in the project's git history:
// - its profile, memory and library live in `<project>/.bot/`;
// - its instructions go in files the providers read but git doesn't track: `CLAUDE.local.md` (Claude)
//   and `AGENTS.override.md` (Codex, which reads it instead of the folder's AGENTS.md, so that file's
//   text is copied in);
// - every file it adds is listed in the repo's `.git/info/exclude`, never in `.gitignore`.
// The tracked CLAUDE.md, AGENTS.md and .gitignore are never written.
//
// `.botapp/adopted.json` lists the adopted folders, so discovery finds Bots outside BOTS_ROOT. Each entry
// remembers what adoption added, so "Turn back into a plain project" can take exactly that away again.
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { MANAGED_END, MANAGED_START } from "./bot-template.mts";

/** Which machine the folder is on. Only this machine for now; the field is there for adopting elsewhere later. */
export const LOCAL_ENVIRONMENT = "local";
export const ADOPTED_REGISTRY = "adopted.json";
export const ADOPTED_ARCHIVE = "adopted-archive";

/** What adoption did to one file, relative to the project folder. */
export type AdoptedFile = {
  path: string;
  /** created: the Bot's own file. merged: the user's file with the Bot's part added. skipped: left alone (tracked by git, or not ours to replace). */
  mode: "created" | "merged" | "skipped";
  /** JSON files: the top-level keys (or `mcpServers.<name>`) adoption added, so undo removes only those. */
  keys?: string[];
  /** JSON files: the user's own values adoption replaced, by the same key names, so undo puts them back. */
  originals?: Record<string, unknown>;
};

export type AdoptedBot = {
  slug: string;
  /** The project folder, as T3 knows it. */
  path: string;
  environmentId: string;
  projectId: string;
  adoptedAt: string;
  /** The repo's exclude file and this folder's path inside the repo; null when the folder isn't in a git repo. */
  git: { exclude: string; prefix: string } | null;
  files: AdoptedFile[];
  /** Folders adoption made (like `.codex`), removed again if empty. */
  createdDirs: string[];
  /** Whether adoption added this folder to Codex's trusted projects. */
  codexTrust: boolean;
};

const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

// ---------- registry ----------

export function adoptedRegistryFile(botsRoot: string) {
  return path.join(botsRoot, ".botapp", ADOPTED_REGISTRY);
}

/** The adopted Bots on record. An unreadable file is an error, never an empty list: that would hide Bots. */
export async function readAdopted(botsRoot: string): Promise<AdoptedBot[]> {
  let text: string;
  try { text = await fs.readFile(adoptedRegistryFile(botsRoot), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const parsed = JSON.parse(text);
  const list: unknown[] = Array.isArray(parsed?.bots) ? parsed.bots : [];
  return list.filter((entry): entry is AdoptedBot => {
    const e = entry as Partial<AdoptedBot> | null;
    return Boolean(e && typeof e.slug === "string" && typeof e.path === "string" && path.isAbsolute(e.path));
  }).map((entry) => ({ ...entry, environmentId: entry.environmentId || LOCAL_ENVIRONMENT, files: entry.files ?? [], createdDirs: entry.createdDirs ?? [], codexTrust: Boolean(entry.codexTrust), git: entry.git ?? null }));
}

async function writeAdopted(botsRoot: string, bots: AdoptedBot[]) {
  const file = adoptedRegistryFile(botsRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, bots }, null, 2) + "\n");
  await fs.rename(`${file}.tmp`, file);
}

export async function registerAdopted(botsRoot: string, entry: AdoptedBot) {
  const bots = await readAdopted(botsRoot);
  if (bots.some((bot) => bot.slug === entry.slug || samePath(bot.path, entry.path))) throw failure("That project is already a Bot.");
  await writeAdopted(botsRoot, [...bots, entry]);
}

export async function unregisterAdopted(botsRoot: string, slug: string) {
  await writeAdopted(botsRoot, (await readAdopted(botsRoot)).filter((bot) => bot.slug !== slug));
}

export function samePath(a: string, b: string) {
  return path.resolve(a).replace(/\/+$/, "") === path.resolve(b).replace(/\/+$/, "");
}

/** Whether `child` is `parent` or inside it. */
export function within(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ---------- git ----------

export type Git = (cwd: string, args: string[]) => Promise<string>;
/** Runs the machine's git. Errors carry git's exit code, or ENOENT when git isn't installed. */
export const runGit: Git = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 8 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** The repo around `dir`: its exclude file and `dir`'s path inside it. Null when `dir` isn't in a git repo. */
export async function gitRepo(dir: string, git: Git = runGit): Promise<AdoptedBot["git"]> {
  let out: string;
  try { out = await git(dir, ["rev-parse", "--show-toplevel", "--git-path", "info/exclude"]); }
  catch (error) {
    const e = error as Error & { code?: unknown };
    // 128: not a repo. Anything else (git missing, a broken repo) must not pass for "no repo".
    if (e.code === 128) return null;
    if (!(await hasGitMarker(dir))) return null;
    throw failure(e.code === "ENOENT" ? "This project is a git repo, but git isn't installed on this machine." : `Couldn't read this project's git repo: ${e.message}`);
  }
  const [top, exclude] = out.split("\n").map((line) => line.trim());
  if (!top || !exclude) throw failure("Couldn't read this project's git repo.");
  const real = await fs.realpath(dir);
  const prefix = path.relative(await fs.realpath(top), real).split(path.sep).join("/");
  if (prefix.startsWith("..")) throw failure("Couldn't place this project inside its git repo.");
  return { exclude: path.resolve(dir, exclude), prefix };
}

async function hasGitMarker(dir: string) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** The given paths (relative to `dir`) that git tracks; a folder counts when anything inside it is tracked. */
export async function trackedPaths(dir: string, paths: string[], git: Git = runGit): Promise<Set<string>> {
  const out = await git(dir, ["ls-files", "-z", "--", ...paths.map((p) => `:(literal)${p}`)]);
  const tracked = out.split("\0").filter(Boolean);
  return new Set(paths.filter((p) => tracked.some((file) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`))));
}

const EXCLUDE_START = (slug: string) => `# threebot:${slug}:start (added when this folder became a Bot; removed when it stops being one)`;
const EXCLUDE_END = (slug: string) => `# threebot:${slug}:end`;

/** One exclude pattern for a path inside the repo, anchored and with git's special characters escaped. */
export function excludePattern(prefix: string, relative: string) {
  const full = [prefix, relative].filter(Boolean).join("/");
  return "/" + full.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ $/, "\\ ");
}

/** Adds (or replaces) this Bot's block in the exclude file. */
export async function writeExcludeBlock(exclude: string, slug: string, patterns: string[]) {
  const current = await fs.readFile(exclude, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  const base = removeBlock(current, slug);
  const block = [EXCLUDE_START(slug), ...patterns, EXCLUDE_END(slug)].join("\n") + "\n";
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.writeFile(exclude, (base && !base.endsWith("\n") ? base + "\n" : base) + block);
}

export async function removeExcludeBlock(exclude: string, slug: string) {
  const current = await fs.readFile(exclude, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (current === null) return;
  const next = removeBlock(current, slug);
  if (next !== current) await fs.writeFile(exclude, next);
}

function removeBlock(text: string, slug: string) {
  const start = text.indexOf(EXCLUDE_START(slug));
  if (start === -1) return text;
  const endMarker = EXCLUDE_END(slug);
  const end = text.indexOf(endMarker, start);
  if (end === -1) return text;
  let after = end + endMarker.length;
  if (text[after] === "\n") after++;
  return text.slice(0, start) + text.slice(after);
}

// ---------- the files adoption adds ----------

/** Where an adopted Bot's own things live, relative to the project folder. */
export const ADOPTED_DATA = ".bot";
export const CLAUDE_FILE = "CLAUDE.local.md";
export const CODEX_FILE = "AGENTS.override.md";
/** The provider config files the gateway writes for every Bot (its tool server), with the adopted names. */
export const CONFIG_FILES = { mcp: ".mcp.json", claude: ".claude/settings.local.json", codex: ".codex/config.toml", pi: ".pi/mcp.json" } as const;

/**
 * Decides, before anything is written, what adoption may do to each file. Instruction files the
 * Bot can't work without must be free; tool-server configs that git tracks, or a Codex config that
 * isn't ours to replace, are skipped (that provider then runs without the Bot's own tools).
 */
export async function planAdoption(dir: string, repo: AdoptedBot["git"], git: Git = runGit) {
  const all = [ADOPTED_DATA, CLAUDE_FILE, CODEX_FILE, ...Object.values(CONFIG_FILES)];
  const tracked = repo ? await trackedPaths(dir, all, git) : new Set<string>();
  for (const required of [ADOPTED_DATA, CLAUDE_FILE, CODEX_FILE]) {
    if (tracked.has(required)) throw failure(`This project's git repo tracks ${required}, which the Bot needs for itself.`);
  }
  if (existsSync(path.join(dir, ADOPTED_DATA))) throw failure(`This project already has a ${ADOPTED_DATA} folder.`);
  const files: AdoptedFile[] = [];
  for (const file of [CLAUDE_FILE, CODEX_FILE, ...Object.values(CONFIG_FILES)]) {
    const exists = existsSync(path.join(dir, file));
    const mode: AdoptedFile["mode"] = tracked.has(file) ? "skipped" : !exists ? "created" : file === CONFIG_FILES.codex ? "skipped" : "merged";
    files.push({ path: file, mode });
  }
  const createdDirs = [".claude", ".codex", ".pi"].filter((folder) => !existsSync(path.join(dir, folder)) && files.some((f) => f.mode !== "skipped" && f.path.startsWith(`${folder}/`)));
  return { files, createdDirs };
}

/** The exclude patterns for what adoption adds: the Bot's folder and every file it writes or merges into. */
export function excludePatterns(entry: Pick<AdoptedBot, "files" | "git">) {
  if (!entry.git) return [];
  return [`${ADOPTED_DATA}/`, ...entry.files.filter((f) => f.mode !== "skipped").map((f) => f.path)].map((file) => excludePattern(entry.git!.prefix, file));
}

/** The repo's own AGENTS.md, for Codex, which reads AGENTS.override.md instead of it. */
export async function projectAgentsMd(dir: string) {
  const text = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8").catch(() => "");
  return text.replaceAll(MANAGED_START, "").replaceAll(MANAGED_END, "").trim();
}

/** The managed block with the project's AGENTS.md copied in, so Codex still follows the repo's own rules. */
export function withProjectAgents(block: string, agents: string) {
  if (!agents) return block;
  const copy = `\n## This project's own instructions\nCopied from the project's AGENTS.md, which Codex doesn't read while this file exists. Follow them for work in this project.\n\n${agents}\n`;
  return block.replace(MANAGED_END, `${copy}${MANAGED_END}`);
}

/** Takes the managed block back out of a file it was merged into, leaving the user's text as it was. */
export function stripManaged(text: string) {
  const s = text.indexOf(MANAGED_START);
  const e = text.indexOf(MANAGED_END);
  if (s === -1 || e === -1) return text;
  let after = e + MANAGED_END.length;
  // mergeManaged put the block, its newline and a blank line in front of the user's text.
  while (text[after] === "\n" && after - (e + MANAGED_END.length) < 2) after++;
  return text.slice(0, s) + text.slice(after);
}

/**
 * Writes a JSON config, recording which keys were the Bot's, for a file adoption may have merged into.
 * `set` lists dotted keys (only `a` or `a.b`) and their values.
 */
export async function mergeJsonFile(file: string, set: Record<string, unknown>, entry: AdoptedFile) {
  const current = await fs.readFile(file, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
  const keys = new Set(entry.keys ?? []);
  const originals = { ...entry.originals };
  for (const [key, value] of Object.entries(set)) {
    const [top, sub] = key.split(".");
    const holder = sub ? (current[top] && typeof current[top] === "object" ? current[top] : (current[top] = {})) : current;
    const name = sub ?? top;
    // The first time adoption writes a key, remember whether it was the user's, and what it held.
    if (entry.mode === "merged" && !keys.has(key) && !(key in originals)) {
      if (name in holder) originals[key] = holder[name]; else keys.add(key);
    }
    holder[name] = value;
  }
  if (entry.mode === "merged") {
    entry.keys = [...keys];
    if (Object.keys(originals).length) entry.originals = originals;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/** Removes the keys adoption added to a user's JSON file, and puts back the values it replaced. */
async function unmergeJsonFile(file: string, keys: string[], originals: Record<string, unknown> = {}) {
  const current = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
  if (!current || typeof current !== "object") return;
  for (const key of keys) {
    const [top, sub] = key.split(".");
    if (sub) {
      if (current[top] && typeof current[top] === "object") {
        delete current[top][sub];
        if (Object.keys(current[top]).length === 0) delete current[top];
      }
    } else delete current[top];
  }
  for (const [key, value] of Object.entries(originals)) {
    const [top, sub] = key.split(".");
    if (sub) (current[top] && typeof current[top] === "object" ? current[top] : (current[top] = {}))[sub] = value;
    else current[top] = value;
  }
  await fs.writeFile(file, JSON.stringify(current, null, 2) + "\n");
}

/**
 * Takes away everything adoption added to the project folder, except `.bot/` (the caller archives it):
 * the Bot's files, its part of merged files, its folders if they are empty, and its exclude lines.
 */
export async function undoAdoptionFiles(entry: AdoptedBot) {
  for (const file of entry.files) {
    const full = path.join(entry.path, file.path);
    if (file.mode === "created") await fs.rm(full, { force: true });
    else if (file.mode === "merged") {
      if (file.path.endsWith(".md")) {
        const text = await fs.readFile(full, "utf8").catch(() => null);
        if (text !== null) {
          const rest = stripManaged(text);
          if (rest !== text) await fs.writeFile(full, rest);
        }
      } else if (file.keys?.length || file.originals) await unmergeJsonFile(full, file.keys ?? [], file.originals);
    }
  }
  for (const folder of entry.createdDirs) await fs.rmdir(path.join(entry.path, folder)).catch(() => {});
  if (entry.git) await removeExcludeBlock(entry.git.exclude, entry.slug);
}

/** Moves the Bot's own folder (profile, memory, library) to `.botapp/adopted-archive/`, never deleting it. */
export async function archiveAdoptedData(botsRoot: string, entry: AdoptedBot, now = Date.now()) {
  const from = path.join(entry.path, ADOPTED_DATA);
  if (!existsSync(from)) return null;
  const to = path.join(botsRoot, ".botapp", ADOPTED_ARCHIVE, `${entry.slug}-${now}`);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try { await fs.rename(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(from, to, { recursive: true, errorOnExist: true });
    await fs.rm(from, { recursive: true, force: true });
  }
  await fs.writeFile(path.join(to, "adopted-from.json"), JSON.stringify({ path: entry.path, environmentId: entry.environmentId, projectId: entry.projectId, adoptedAt: entry.adoptedAt, releasedAt: new Date(now).toISOString() }, null, 2) + "\n");
  return to;
}

export async function updateAdopted(botsRoot: string, entry: AdoptedBot) {
  const bots = await readAdopted(botsRoot);
  await writeAdopted(botsRoot, bots.map((bot) => bot.slug === entry.slug ? entry : bot));
}
