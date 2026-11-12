// Creating a room's member threads. Each member gets its own ordinary T3 thread in its own
// project, titled `#<room>`, so the Bot's one-to-one conversation is not in the room's context.
import { randomUUID } from "node:crypto";
import type { Room, RoomSettings } from "./rooms.mts";

/** The slice of the T3 client the threads need; a test passes a fake. */
export type RoomRpc = { call(tag: string, payload: object): Promise<unknown> };
export type RoomBot = {
  slug: string;
  name: string;
  projectId: string | null;
  mainThreadId: string | null;
  /** The Bot's own model choice, when it has one. */
  model?: unknown;
};
/** What the app would use for a Bot that has no main thread yet. */
export type LaunchDefaults = { runtimeMode?: string; model?: unknown };

type Projection = { thread?: { runtimeMode?: unknown; modelSelection?: unknown } | null } | null;

/**
 * `inherit` reads the Bot's main thread once: its runtime mode and its model selection.
 * A Bot with no main thread (or an unreadable projection) falls back to the app's defaults.
 */
export async function resolveMemberLaunch({ rpc, bot, settings, defaults }: {
  rpc: RoomRpc;
  bot: RoomBot;
  settings: RoomSettings;
  defaults: LaunchDefaults;
}): Promise<{ runtimeMode: string; modelSelection: unknown }> {
  let projection: Projection = null;
  if (bot.mainThreadId) {
    projection = (await rpc.call("orchestration.getThreadProjection", { threadId: bot.mainThreadId }).catch(() => null)) as Projection;
  }
  const runtimeMode = settings.runtimeMode !== "inherit"
    ? settings.runtimeMode
    : (typeof projection?.thread?.runtimeMode === "string" && projection.thread.runtimeMode)
      || defaults.runtimeMode
      || "auto";
  const modelSelection = settings.model !== "inherit" && settings.model !== undefined && settings.model !== null
    ? settings.model
    : (projection?.thread?.modelSelection ?? bot.model ?? defaults.model ?? null);
  return { runtimeMode, modelSelection };
}

/**
 * Launches the member's room thread. A new thread is launched on retry only when the member has
 * none: the id is stored as soon as T3 accepts it, so a lost reply cannot create a second thread.
 */
export async function launchRoomThread({ rpc, room, slug, bot, settings, defaults }: {
  rpc: RoomRpc;
  room: Room;
  slug: string;
  bot: RoomBot;
  settings: RoomSettings;
  defaults: LaunchDefaults;
}): Promise<{ threadId: string; runtimeMode: string; modelSelection: unknown }> {
  const member = room.members.find((candidate) => candidate.slug === slug);
  if (member?.threadId) {
    return { threadId: member.threadId, runtimeMode: member.runtimeMode, modelSelection: member.model };
  }
  if (!bot.projectId) throw new Error(`${bot.name} has no T3 project yet`);
  const { runtimeMode, modelSelection } = await resolveMemberLaunch({ rpc, bot, settings, defaults });
  const threadId = randomUUID();
  await rpc.call("orchestration.launchThread", {
    commandId: randomUUID(),
    threadId,
    projectId: bot.projectId,
    title: `#${room.name}`,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  return { threadId, runtimeMode, modelSelection };
}
