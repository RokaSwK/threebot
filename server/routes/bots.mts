// Bot routes: /api/bots*, /api/bot-identities, /api/adoptable-projects, /api/main-bot, /api/memory*, /api/instructions, /api/bot-map.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createRouter, type SendFn } from "./router.mts";
import type { EventStream } from "./events.mts";
import type { Bot, BotPatch } from "../main-bot.mts";
import type { TemplateSettings } from "../bot-template.mts";
import type { InstructionsTarget } from "../instructions.mts";
import type { MemoryTidyFrequency } from "../memory-tidy.mts";

export function createBotRoutes({
  appDir,
  listBots,
  getBot,
  saveBot,
  createBot,
  selectMainBot,
  removeBot,
  archivedBotIdentities,
  adoptableProjects,
  adoptProject,
  releaseAdopted,
  readAvatarImage,
  sendBotImage,
  botFace,
  botBadgePng,
  avatarBodyLimit,
  codingWorkPatch,
  readMemoryFiles,
  saveMemoryFile,
  memoryTidyPrompt,
  setMemoryTidy,
  loadInstructions,
  instructionsTarget,
  saveInstructions,
  writeAgentsMd,
  getSettings,
  t3rpc,
  withTimeout,
  botMapRead,
  events,
  send,
  readBody,
  requireJson,
}: {
  appDir: string;
  listBots: () => Promise<Bot[]>;
  getBot: (slug: string) => Promise<Bot | null>;
  saveBot: (slug: string, patch: BotPatch) => Promise<Bot>;
  createBot: (input: any) => Promise<Bot>;
  selectMainBot: (slug: string) => Promise<Bot[]>;
  removeBot: (slug: string) => Promise<Bot[]>;
  archivedBotIdentities: (trashDir: string) => Promise<Array<{ slug: string; workspaceRoot: string; [key: string]: any }>>;
  adoptableProjects: () => Promise<unknown[]>;
  adoptProject: (input: any) => Promise<unknown>;
  releaseAdopted: (slug: string) => Promise<unknown>;
  readAvatarImage: (bot: Bot, urlPath: string) => Promise<Buffer>;
  sendBotImage: (res: ServerResponse, image: Promise<Buffer | { png: Buffer; fallback: boolean }>) => Promise<void>;
  botFace: (bot: Bot) => Promise<Buffer | { png: Buffer; fallback: boolean }>;
  botBadgePng: (bot: Bot) => Promise<Buffer | { png: Buffer; fallback: boolean }>;
  avatarBodyLimit: number;
  codingWorkPatch: (value: unknown) => any;
  readMemoryFiles: (opts: { botDir: string; sharedFile: string; botPath?: string }) => Promise<Record<string, unknown>>;
  saveMemoryFile: (opts: { botDir: string; sharedFile: string; scope: "shared" | "bot"; text: unknown; expectedRevision: unknown }) => Promise<{ ok: boolean; code?: string; [key: string]: unknown }>;
  memoryTidyPrompt: (bot: Bot) => string;
  setMemoryTidy: (opts: { client: any; bot: Bot; frequency: MemoryTidyFrequency; modelSelection: unknown }) => Promise<{ task?: { id: string } | null }>;
  loadInstructions: (bot: Bot) => Promise<{ revision: string; [key: string]: unknown }>;
  instructionsTarget: (bot: Bot) => InstructionsTarget;
  saveInstructions: (target: InstructionsTarget, opts: { text: unknown; expectedRevision: unknown }) => Promise<{ ok: boolean; code?: string; [key: string]: unknown }>;
  writeAgentsMd: (bot: Bot, settings: TemplateSettings) => Promise<void>;
  getSettings: () => Promise<TemplateSettings>;
  t3rpc: () => Promise<any>;
  withTimeout: <T>(promise: Promise<T>, ms: number, message: string) => Promise<T>;
  botMapRead: () => Promise<unknown>;
  events: EventStream;
  send: SendFn;
  readBody: (req: IncomingMessage, limit?: number) => Promise<any>;
  requireJson: (req: IncomingMessage) => void;
}) {
  const router = createRouter();

  router.put("/api/main-bot", async ({ req, res }) => {
    requireJson(req);
    const body = await readBody(req);
    const bots = await selectMainBot(body?.slug);
    events.emit("bots", { action: "main-bot" });
    return send(res, 200, { bots }, { "cache-control": "no-store" });
  });

  router.get("/api/bot-map", async ({ res }) => {
    return send(res, 200, await botMapRead(), { "cache-control": "no-store" });
  });

  router.get("/api/bots", async ({ res }) => {
    return send(res, 200, { bots: await listBots() }, { "cache-control": "no-store" });
  });

  router.get("/api/memory", async ({ res, url }) => {
    const bot = await getBot(url.searchParams.get("slug") ?? "");
    if (!bot) return send(res, 404, { error: "Bot not found" });
    const files = await readMemoryFiles({ botDir: bot.dataDir, sharedFile: path.join(appDir, "shared-memory.md"), botPath: bot.adopted ? ".bot/memory/MEMORY.md" : undefined });
    return send(res, 200, { ...files, tidyPrompt: memoryTidyPrompt(bot) }, { "cache-control": "no-store" });
  });

  router.post("/api/memory/tidy", async ({ req, res }) => {
    requireJson(req);
    const body = await readBody(req, 4096);
    const bot = await getBot(String(body?.slug ?? ""));
    if (!bot) return send(res, 404, { error: "Bot not found" });
    const frequency = body?.frequency;
    if (frequency !== "off" && frequency !== "weekly" && frequency !== "nightly") return send(res, 400, { error: "frequency must be off, weekly or nightly" });
    if (bot.environmentId !== "local") return send(res, 409, { error: "Memory tidy is only available for Bots on this machine." });
    if (!bot.projectId || !bot.mainThreadId) return send(res, 409, { error: "This Bot needs a main conversation first." });
    const client = await withTimeout(t3rpc(), 10_000, "T3 timed out");
    const projection = await withTimeout(client.call("orchestration.getThreadProjection", { threadId: bot.mainThreadId }), 15_000, "T3 timed out") as { thread?: { modelSelection?: unknown } } | null;
    const modelSelection = projection?.thread?.modelSelection ?? bot.model;
    if (!modelSelection) return send(res, 409, { error: "Pick a model for this Bot first." });
    const result = await setMemoryTidy({ client, bot, frequency: frequency as MemoryTidyFrequency, modelSelection });
    if (result.task && result.task.id !== bot.memoryTidyRoutineId) {
      await saveBot(bot.slug, { memoryTidyRoutineId: result.task.id });
      events.emit("bots", { action: "updated", slug: bot.slug });
    }
    return send(res, 200, { frequency, task: result.task }, { "cache-control": "no-store" });
  });

  router.get("/api/instructions", async ({ res, url }) => {
    const bot = await getBot(url.searchParams.get("slug") ?? "");
    if (!bot) return send(res, 404, { error: "Bot not found" });
    return send(res, 200, await loadInstructions(bot), { "cache-control": "no-store" });
  });

  router.put("/api/instructions", async ({ req, res }) => {
    requireJson(req);
    const body = await readBody(req);
    const bot = await getBot(String(body?.slug ?? ""));
    if (!bot) return send(res, 404, { error: "Bot not found" });
    await loadInstructions(bot);
    const result = await saveInstructions(instructionsTarget(bot), { text: body?.text, expectedRevision: body?.expectedRevision });
    // An adopted Bot's text is copied into its managed files; write them now, not on the next watcher tick.
    if (result.ok && bot.adopted) await writeAgentsMd(bot, await getSettings());
    return send(res, result.ok ? 200 : result.code === "conflict" ? 409 : 400, result, { "cache-control": "no-store" });
  });

  router.put("/api/memory", async ({ req, res }) => {
    requireJson(req);
    const body = await readBody(req);
    const bot = await getBot(String(body?.slug ?? ""));
    if (!bot) return send(res, 404, { error: "Bot not found" });
    const result = await saveMemoryFile({
      botDir: bot.dataDir,
      sharedFile: path.join(appDir, "shared-memory.md"),
      scope: body?.scope === "shared" ? "shared" : "bot",
      text: body?.text,
      expectedRevision: body?.expectedRevision,
    });
    return send(res, result.ok ? 200 : result.code === "conflict" ? 409 : 400, result, { "cache-control": "no-store" });
  });

  router.get("/api/bot-identities", async ({ res }) => {
    return send(res, 200, { bots: await archivedBotIdentities(path.join(appDir, "trash")) }, { "cache-control": "no-store" });
  });

  router.post("/api/bots", async ({ req, res }) => {
    requireJson(req);
    const created = await createBot(await readBody(req, avatarBodyLimit));
    events.emit("bots", { action: "created", slug: created.slug });
    return send(res, 200, created);
  });

  router.get("/api/adoptable-projects", async ({ res }) => {
    return send(res, 200, { projects: await adoptableProjects() }, { "cache-control": "no-store" });
  });

  router.post("/api/bots/adopt", async ({ req, res }) => {
    requireJson(req);
    const adopted = await adoptProject(await readBody(req, avatarBodyLimit));
    events.emit("bots", { action: "adopted" });
    return send(res, 200, adopted);
  });

  router.post(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/release$/, async ({ req, res, match }) => {
    requireJson(req);
    const released = await releaseAdopted(match![1]);
    events.emit("bots", { action: "released", slug: match![1] });
    return send(res, 200, released, { "cache-control": "no-store" });
  });

  router.get(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/avatar\/([a-f0-9]{64})\.png$/, async ({ res, path: p, match }) => {
    const candidates = [await getBot(match![1]), ...await archivedBotIdentities(path.join(appDir, "trash"))].filter((b): b is NonNullable<typeof b> => b?.slug === match![1]);
    for (const bot of candidates) {
      try {
        return send(res, 200, await readAvatarImage(bot as Parameters<typeof readAvatarImage>[0], p), { "content-type": "image/png", "content-security-policy": "default-src 'none'", "cache-control": "private, max-age=31536000, immutable" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return send(res, 404, { error: "not found" });
  });

  router.get(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/avatar\.png$/, async ({ res, match }) => {
    const bot = await getBot(match![1]);
    return bot ? await sendBotImage(res, botFace(bot)) : send(res, 404, { error: "not found" });
  });

  router.get(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/badge\.png$/, async ({ res, match }) => {
    const bot = await getBot(match![1]);
    return bot ? await sendBotImage(res, botBadgePng(bot)) : send(res, 404, { error: "not found" });
  });

  router.get(/^\/api\/bots\/([^/]+)$/, async ({ res, match }) => {
    const b = await getBot(match![1]);
    return b ? send(res, 200, b) : send(res, 404, { error: "not found" });
  });

  router.put(/^\/api\/bots\/([^/]+)$/, async ({ req, res, match }) => {
    requireJson(req);
    const patch = await readBody(req, avatarBodyLimit);
    if (patch && typeof patch === "object" && "codingWork" in patch) patch.codingWork = codingWorkPatch(patch.codingWork);
    const updated = await saveBot(match![1], patch);
    events.emit("bots", { action: "updated", slug: match![1] });
    return send(res, 200, updated);
  });

  router.delete(/^\/api\/bots\/([^/]+)$/, async ({ res, match }) => {
    const bots = await removeBot(match![1]);
    events.emit("bots", { action: "deleted", slug: match![1] });
    return send(res, 200, { ok: true, bots });
  });

  return { handle: router.handle };
}
