// Keeps T3 in step with the Bot folders, without a browser open:
// - a Bot folder with no projectId (for example a helper Bot another Bot just made)
//   gets a T3 project and a main thread, and its brief is delivered as its first message;
// - the T3 project title and favicon follow the profile in bot.json, except for a Bot made from an
//   existing project, whose project stays as the user named it.
import { randomUUID } from "node:crypto";
import { T3Client } from "./t3rpc.mts";
import { syncBotProject } from "./bot-avatar.mts";
import type { Bot, BotPatch } from "./main-bot.mts";

/** A project as T3's /api/projects lists it; only the fields used here. */
type T3Project = { id: string; workspaceRoot?: string; defaultModelSelection?: unknown; [key: string]: unknown };
/** The global settings the provisioner reads. */
type ProvisionerSettings = { defaultModel?: unknown; autoReview?: boolean };

const DEFAULT_MODEL = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] };

export type SeedDeps = {
  writeInstructions?: (bot: Bot, text: string) => Promise<unknown>;
  saveBot: (slug: string, patch: BotPatch) => Promise<unknown>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Writes the standing instructions a helper Bot brought in its bot.json, before T3 starts it.
 * A bad seed must not keep the Bot from starting: a permanent 400 drops the field, anything
 * else stays for the next tick. Returns whether the text was written.
 */
export async function seedInstructions(bot: Bot, { writeInstructions, saveBot, log = console.log, error = console.error }: SeedDeps): Promise<boolean> {
  if (bot.adopted) {
    if (typeof bot.instructions === "string" && bot.instructions.trim()) {
      await saveBot(bot.slug, { instructions: null }).catch((cause) => error(`[provisioner] ${bot.slug}: could not clear its instruction seed: ${(cause as Error).message ?? cause}`));
    }
    return false;
  }
  const text = typeof bot.instructions === "string" ? bot.instructions : "";
  if (!text.trim() || !writeInstructions) return false;
  try {
    await writeInstructions(bot, text);
  } catch (cause) {
    error(`[provisioner] ${bot.slug}: could not write its instructions: ${(cause as Error).message ?? cause}`);
    if ((cause as { status?: number }).status === 400) {
      await saveBot(bot.slug, { instructions: null }).catch((clearError) => error(`[provisioner] ${bot.slug}: could not drop its invalid instruction seed: ${(clearError as Error).message ?? clearError}`));
      error(`[provisioner] ${bot.slug}: dropped an invalid instruction seed`);
    }
    return false;
  }
  await saveBot(bot.slug, { instructions: null }).catch((cause) => error(`[provisioner] ${bot.slug}: could not clear its instruction seed: ${(cause as Error).message ?? cause}`));
  log(`[provisioner] wrote instructions for ${bot.slug}`);
  return true;
}

export function startProvisioner({ t3Url, token, listBots, saveBot, getSettings, writeInstructions, intervalMs = 5000 }: {
  t3Url: string; token: string; listBots: () => Promise<Bot[]>; saveBot: (slug: string, patch: BotPatch) => Promise<unknown>;
  getSettings: () => Promise<ProvisionerSettings>; intervalMs?: number;
  /** Writes a Bot's standing instructions into its AGENTS.md; absent in tests that don't need files. */
  writeInstructions?: (bot: Bot, text: string) => Promise<unknown>;
}) {
  let client: T3Client | null = null;
  let busy = false;

  async function connect() {
    if (client) return client;
    const c = new T3Client({ baseUrl: t3Url, token, clientLabel: "bot-gateway" });
    await c.connect();
    c.ws.addEventListener("close", () => {
      if (client === c) client = null;
    });
    client = c;
    return c;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const bots = await listBots();
      const c = await connect();
      const { projects } = await c.http("/api/projects");
      const byId = new Map<string, T3Project>(projects.map((p: T3Project) => [p.id, p]));
      const settings = await getSettings();
      for (const bot of bots) {
        // One bad Bot (a malformed seed, an unavailable project) must not starve the rest of the roster.
        try {
          // Seed the standing role before either path can launch a session.
          if (typeof bot.instructions === "string" && bot.instructions.trim()) await seedInstructions(bot, { writeInstructions, saveBot });
          if (!bot.projectId || !byId.has(bot.projectId)) {
            await provision(c, bot, settings, byId);
          } else {
            const p = byId.get(bot.projectId)!;
            // A project the Bot was made from keeps its own title and icon.
            if (!bot.adopted) await syncBotProject(c, bot, p);
            if (!bot.mainThreadId) await launchMain(c, bot, settings, p.defaultModelSelection);
            else if (bot.pendingBrief) await deliverBrief(c, bot);
          }
        } catch (error) {
          console.error(`[provisioner] ${bot.slug}:`, (error as Error).message ?? error);
        }
      }
    } catch (err) {
      console.error("[provisioner]", (err as Error).message ?? err);
      try { client?.close(); } catch {}
      client = null;
    } finally {
      busy = false;
    }
  }

  async function provision(c: T3Client, bot: Bot, settings: ProvisionerSettings, byId: Map<string, T3Project>) {
    const existing = [...byId.values()].find((p) => p.workspaceRoot === bot.workspaceRoot);
    const model = bot.model ?? settings.defaultModel ?? DEFAULT_MODEL;
    let projectId = existing?.id;
    if (!projectId) {
      projectId = randomUUID();
      await c.call("projects.mutate", {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title: bot.name,
        workspaceRoot: bot.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: model,
      });
      console.log(`[provisioner] created project for ${bot.slug}`);
    }
    await saveBot(bot.slug, { projectId });
    if (!bot.adopted) await syncBotProject(c, bot, { ...existing, id: projectId });
    await launchMain(c, { ...bot, projectId }, settings, model);
  }

  async function launchMain(c: T3Client, bot: Bot, settings: ProvisionerSettings, model: unknown) {
    const threadId = randomUUID();
    await c.call("orchestration.launchThread", {
      commandId: randomUUID(),
      threadId,
      projectId: bot.projectId,
      title: bot.name,
      modelSelection: model ?? settings.defaultModel ?? DEFAULT_MODEL,
      runtimeMode: settings.autoReview === false ? "full-access" : "auto",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
    await saveBot(bot.slug, { mainThreadId: threadId, model: null });
    console.log(`[provisioner] started main thread for ${bot.slug}`);
    if (bot.brief || bot.pendingBrief) await deliverBrief(c, { ...bot, mainThreadId: threadId });
  }

  async function deliverBrief(c: T3Client, bot: Bot) {
    const brief = bot.pendingBrief ?? bot.brief;
    if (!brief) return;
    const from = bot.createdBy ? `From ${bot.createdBy}: ` : "";
    await c.dispatch({
      type: "message.dispatch",
      threadId: bot.mainThreadId,
      messageId: randomUUID(),
      text: from + brief,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
    await saveBot(bot.slug, { brief: null, pendingBrief: null });
  }

  let running: Promise<void> | null = null;
  const runNow = async () => {
    while (busy) await new Promise((r) => setTimeout(r, 100));
    running = tick();
    await running;
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop: () => clearInterval(timer), runNow };
}
