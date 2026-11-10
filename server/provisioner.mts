// Keeps T3 in step with the Bot folders, without a browser open:
// - a Bot folder with no projectId (for example a helper Bot another Bot just made)
//   gets a T3 project and a main thread, and its brief is delivered as its first message;
// - the T3 project title and favicon follow the profile in bot.json.
import { randomUUID } from "node:crypto";
import { T3Client } from "./t3rpc.mts";
import { syncBotProject } from "./bot-avatar.mts";
import type { Bot, BotPatch } from "./main-bot.mts";
import { ensureMemoryRoutine } from "./memory-routine.mts";

/** A project as T3's /api/projects lists it; only the fields used here. */
type T3Project = { id: string; workspaceRoot?: string; defaultModelSelection?: unknown; [key: string]: unknown };
/** The global settings the provisioner reads. */
type ProvisionerSettings = { defaultModel?: unknown; memoryReflectionModel?: unknown; autoReview?: boolean };

const DEFAULT_MODEL = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] };

export function startProvisioner({ t3Url, token, listBots, saveBot, getSettings, intervalMs = 5000 }: {
  t3Url: string; token: string; listBots: () => Promise<Bot[]>; saveBot: (slug: string, patch: BotPatch) => Promise<unknown>;
  getSettings: () => Promise<ProvisionerSettings>; intervalMs?: number;
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
        if (!bot.projectId || !byId.has(bot.projectId)) {
          await provision(c, bot, settings, byId);
        } else {
          const p = byId.get(bot.projectId)!;
          await syncBotProject(c, bot, p);
          if (!bot.mainThreadId) await launchMain(c, bot, settings, p.defaultModelSelection);
          else if (bot.pendingBrief) await deliverBrief(c, bot);
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
    await syncBotProject(c, bot, { ...existing, id: projectId });
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
    if (settings.memoryReflectionModel) {
      await ensureMemoryRoutine({
        client: c,
        bot: { ...bot, projectId: bot.projectId, mainThreadId: threadId },
        modelSelection: settings.memoryReflectionModel,
      }).catch((error) => console.error(`[provisioner] memory routine for ${bot.slug}`, error));
    }
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
