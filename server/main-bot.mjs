import { promises as fs } from "node:fs";
import path from "node:path";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(`${file}.tmp`, file);
}

/** One writer owns the selection and its compatibility flags, including provisioning writes. */
export function createMainBotRegistry({ botsRoot, onBotChanged = async () => {} }) {
  const selectionFile = path.join(botsRoot, ".botapp", "main-bot.json");
  let pending = Promise.resolve();
  function exclusive(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  function directory(slug) {
    if (typeof slug !== "string" || !SLUG.test(slug)) throw failure("bad slug", 400);
    return path.join(botsRoot, slug);
  }
  const metadataFile = (slug) => path.join(directory(slug), ".bot", "bot.json");

  async function loadBots() {
    const entries = await fs.readdir(botsRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const bots = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
      const meta = await readJson(metadataFile(entry.name), null);
      if (!meta) continue;
      const createdAt = meta.createdAt ?? (await fs.stat(metadataFile(entry.name))).birthtime.toISOString();
      bots.push({
        label: "", shape: "sphere", color: "teal", section: null, pinned: false,
        hidden: false, primary: false, notifications: true, projectId: null, mainThreadId: null,
        ...meta, name: typeof meta.name === "string" && meta.name.trim() ? meta.name : entry.name,
        createdAt, slug: entry.name, workspaceRoot: directory(entry.name),
      });
    }
    return bots.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
  }

  async function persistMetadata(bot) {
    const { slug, workspaceRoot: _workspace, ...metadata } = bot;
    await writeJson(metadataFile(slug), metadata);
  }

  async function reconcile() {
    const bots = await loadBots();
    const selection = await readJson(selectionFile, null);
    // A persisted choice outranks every legacy/self-written primary flag.
    const visible = bots.filter((bot) => !bot.hidden);
    const main = bots.find((bot) => bot.slug === selection?.slug)
      ?? (selection === null ? visible.find((bot) => bot.primary) : null)
      ?? visible[0] ?? bots[0] ?? null;
    if (selection === null || selection.slug !== (main?.slug ?? null)) {
      await writeJson(selectionFile, { slug: main?.slug ?? null });
    }
    for (const bot of bots) {
      const primary = bot.slug === main?.slug;
      if (bot.primary !== primary || (primary && bot.hidden)) {
        bot.primary = primary;
        if (primary) bot.hidden = false;
        await persistMetadata(bot);
        await onBotChanged(bot);
      }
    }
    return bots;
  }

  async function choose(slug) {
    directory(slug);
    const bots = await reconcile();
    const target = bots.find((bot) => bot.slug === slug);
    if (!target) throw failure("Bot not found", 404);
    // Commit the authority first. A restart repairs flags if interrupted afterward.
    await writeJson(selectionFile, { slug });
    if (target.hidden) {
      target.hidden = false;
      await persistMetadata(target);
    }
    return reconcile();
  }

  return {
    list: () => exclusive(reconcile),
    refreshInstructions: () => exclusive(async () => {
      for (const bot of await reconcile()) await onBotChanged(bot);
    }),
    get: (slug) => exclusive(async () => {
      directory(slug);
      return (await reconcile()).find((bot) => bot.slug === slug) ?? null;
    }),
    select: (slug) => exclusive(() => choose(slug)),
    save: (slug, patch, { create = false } = {}) => exclusive(async () => {
      directory(slug);
      const bots = await reconcile();
      const current = bots.find((bot) => bot.slug === slug);
      if (!current && !create) throw failure("Bot not found", 404);
      if ("primary" in patch && typeof patch.primary !== "boolean") throw failure("primary must be a boolean", 400);
      if ("hidden" in patch && typeof patch.hidden !== "boolean") throw failure("hidden must be a boolean", 400);
      if (current?.primary && (patch.hidden === true || patch.primary === false)) {
        throw failure("Choose another main Bot first.");
      }
      const { slug: _slug, workspaceRoot: _workspace, primary: requestedMain, ...clean } = patch;
      const next = { ...current, ...clean, slug, primary: current?.primary ?? false, updatedAt: new Date().toISOString() };
      if (requestedMain === true) next.hidden = false;
      await persistMetadata(next);
      const updated = requestedMain === true ? await choose(slug) : await reconcile();
      const saved = updated.find((bot) => bot.slug === slug);
      await onBotChanged(saved);
      return saved;
    }),
    remove: (slug) => exclusive(async () => {
      directory(slug);
      const bots = await reconcile();
      const current = bots.find((bot) => bot.slug === slug);
      if (!current) throw failure("Bot not found", 404);
      if (current.primary && bots.length > 1) throw failure("Choose another main Bot before deleting this Bot.");
      const trash = path.join(botsRoot, ".botapp", "trash");
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(directory(slug), path.join(trash, `${slug}-${Date.now()}`));
      return reconcile();
    }),
  };
}
