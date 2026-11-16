// HTTP routes for rooms. The caller has already checked the user is signed in.
//   GET    /api/rooms               summaries for the sidebar
//   POST   /api/rooms               create (2–8 Bots, launches one thread per member)
//   GET    /api/rooms/:id           the room, its members and the turn index
//   PATCH  /api/rooms/:id           change settings or membership
//   DELETE /api/rooms/:id           delete the room and its member threads in T3
//   POST   /api/rooms/:id/messages  start or queue a turn
//   POST   /api/rooms/:id/stop      interrupt the members that are answering
//   POST   /api/rooms/:id/reset     forget the messages and start every Bot a fresh session
import type { IncomingHttpHeaders } from "node:http";
import {
  MAX_MESSAGE, RoomsError, validateAttachments, validateMembers, type BotIdentity, type Room, type RoomMember, type RoomsStore,
} from "./rooms.mts";
import { launchRoomThread, resolveMemberLaunch, type LaunchDefaults, type RoomBot, type RoomRpc } from "./rooms-threads.mts";
import type { RoomEngine, RoomMessage } from "./room-turn.mts";

/** A Bot as the room routes need it: identity, the avatar profile, and where its threads live. */
export type RoomBotView = BotIdentity & {
  label?: string;
  color?: string;
  shape?: string;
  avatarImage?: string | null;
  /** Used to launch the member's room thread; never sent to the page. */
  projectId?: string | null;
  mainThreadId?: string | null;
  model?: unknown;
};

export type RoomsRequest = { method?: string; headers: IncomingHttpHeaders; url?: string };
export type MemberView = RoomBotView & {
  threadId: string | null;
  status: RoomMember["status"];
  model: unknown;
  runtimeMode: string;
  lastTurnAt: string | null;
  /** A member that left the room: its thread is kept for history, never addressed. */
  removed?: boolean;
};
export type RoomView = Omit<Room, "members" | "formerMembers"> & { members: MemberView[]; formerMembers: MemberView[] };

export function createRoomRoutes<Req extends RoomsRequest, Res>({ rooms, engine, rpc, bots, launch, send, readBody, requireJson, checkOrigin, log = () => {} }: {
  rooms: RoomsStore;
  engine: RoomEngine;
  /** The same T3 client the engine uses. `dispatch` deletes a room's threads. */
  rpc: RoomRpc & { dispatch(command: object): Promise<unknown> };
  /** Every Bot the user has, so a member slug has a name and a face. */
  bots: () => Promise<RoomBotView[]>;
  /** Resolves the launch defaults (`inherit`) from the app settings. */
  launch: () => Promise<LaunchDefaults>;
  send: (res: Res, status: number, body: unknown, headers?: Record<string, string>) => void;
  readBody: (req: Req, limit?: number) => Promise<any>;
  requireJson: (req: Req) => void;
  checkOrigin: (req: Req) => boolean;
  log?: (line: string) => void;
}) {
  const bySlug = async (): Promise<Map<string, RoomBotView>> => new Map((await bots()).map((bot) => [bot.slug, bot]));

  /** A member as the page sees it; the roster is resolved once per request, not once per room. */
  function memberView(member: RoomMember, roster: Map<string, RoomBotView>, removed = false): MemberView {
    const bot = roster.get(member.slug);
    return {
      slug: member.slug,
      name: bot?.name ?? member.name ?? member.slug,
      label: bot?.label ?? "",
      color: bot?.color ?? "gray",
      shape: bot?.shape ?? "sphere",
      avatarImage: bot?.avatarImage ?? null,
      threadId: member.threadId,
      status: roster.has(member.slug) ? member.status : "unavailable",
      model: member.model,
      runtimeMode: member.runtimeMode,
      lastTurnAt: member.lastTurnAt,
      ...(removed ? { removed: true } : {}),
    };
  }

  async function view(room: Room, roster?: Map<string, RoomBotView>): Promise<RoomView> {
    const known = roster ?? await bySlug();
    return {
      ...room,
      members: room.members.map((member) => memberView(member, known)),
      formerMembers: room.formerMembers.map((member) => memberView(member, known, true)),
    };
  }

  async function summary(room: Room, roster?: Map<string, RoomBotView>) {
    const full = await view(room, roster);
    const activity = [room.turns.at(-1)?.at ?? null, ...room.members.map((member) => member.lastTurnAt)]
      .filter((at): at is string => !!at)
      .sort()
      .at(-1) ?? null;
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      section: room.section,
      pinned: room.pinned,
      mode: room.settings.mode,
      members: full.members.map(({ slug, name, label, color, shape, avatarImage }) => ({ slug, name, label, color, shape, avatarImage })),
      lastTurnAt: room.turns.at(-1)?.at ?? null,
      lastActivityAt: activity,
      lastText: room.turns.at(-1)?.text.slice(0, 80) ?? room.description,
      queued: room.turns.filter((turn) => turn.status === "queued").length,
      running: room.turns.some((turn) => turn.status === "running") || engine.isBusy(room.id),
    };
  }

  /** A new member gets a thread as soon as it is added; a failure leaves it `pending`. */
  async function launchMembers(room: Room, slugs: string[], roster?: Map<string, RoomBotView>): Promise<Room> {
    const known = roster ?? await bySlug();
    const defaults = await launch();
    // Launches are independent; the store serializes the member writes, so a room with eight
    // members opens in one launch time instead of eight.
    const results = await Promise.all(slugs.map(async (slug) => {
      const bot = known.get(slug);
      if (!bot) return null;
      try {
        const launched = await launchRoomThread({ rpc, room, slug, bot: bot as RoomBot, settings: room.settings, defaults });
        return { slug, patch: { threadId: launched.threadId, status: "ready" as const, model: launched.modelSelection, runtimeMode: launched.runtimeMode } };
      } catch (err) {
        log(`[rooms] could not launch ${slug}: ${(err as Error).message}`);
        return { slug, patch: { status: "pending" as const } };
      }
    }));
    let latest = room;
    for (const result of results) {
      if (result) latest = await rooms.setMember(room.id, result.slug, result.patch);
    }
    return latest;
  }

  /** Deletes each member thread; a Stop has already run, so no run should be holding them. */
  async function deleteThreads(room: Room): Promise<{ deleted: number; failed: { threadId: string; error: string }[] }> {
    const threadIds = [...new Set([...room.members, ...room.formerMembers].flatMap((member) => (member.threadId ? [member.threadId] : [])))];
    const failed: { threadId: string; error: string }[] = [];
    let deleted = 0;
    await Promise.all(threadIds.map(async (threadId) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await rpc.dispatch({ type: "thread.delete", threadId });
          deleted += 1;
          return;
        } catch (err) {
          if (attempt === 1) failed.push({ threadId, error: (err as Error).message });
          else await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }));
    return { deleted, failed };
  }

  return {
    async handle(req: Req, res: Res, url: URL): Promise<boolean> {
      const path = url.pathname;
      if (!path.startsWith("/api/rooms")) return false;
      const rest = path.slice("/api/rooms".length);
      const [, id, action] = rest.split("/");
      const method = req.method ?? "GET";
      const write = method !== "GET" && method !== "HEAD";

      try {
        if (write) {
          requireJson(req);
          if (!checkOrigin(req)) return send(res, 403, { error: "forbidden origin" }), true;
        }

        if (rest === "" || rest === "/") {
          if (method === "GET") {
            // One roster per request: the sidebar used to reconcile every Bot once per room.
            const roster = await bySlug();
            const list = await rooms.list();
            return send(res, 200, { rooms: await Promise.all(list.map((candidate) => summary(candidate, roster))) }, { "cache-control": "no-store" }), true;
          }
          if (method === "POST") {
            const body = (await readBody(req)) ?? {};
            const roster = await bySlug();
            const members = validateMembers(body.members, [...roster.values()]);
            const created = await rooms.create({ ...body, members });
            const launched = await launchMembers(created, members.map((bot) => bot.slug), roster);
            return send(res, 201, { room: await view(launched, roster) }, { "cache-control": "no-store" }), true;
          }
          return send(res, 405, { error: "method not allowed" }), true;
        }

        if (!id) return send(res, 404, { error: "no such room" }), true;
        const room = await rooms.get(id);
        if (!room) return send(res, 404, { error: "no such room" }), true;
        const roster = await bySlug();

        if (!action) {
          if (method === "GET") return send(res, 200, { room: await view(room, roster) }, { "cache-control": "no-store" }), true;
          if (method === "PATCH") {
            const body = (await readBody(req)) ?? {};
            const members = Array.isArray(body.members) ? validateMembers(body.members, [...roster.values()]) : null;
            const updated = await rooms.update(id, { ...body, ...(members ? { members } : {}) });
            const pending = updated.members.filter((member) => !member.threadId).map((member) => member.slug);
            const launched = pending.length > 0 ? await launchMembers(updated, pending, roster) : updated;
            return send(res, 200, { room: await view(launched, roster) }, { "cache-control": "no-store" }), true;
          }
          if (method === "DELETE") {
            // The member threads belong to this room; leaving them behind is the room equivalent of
            // keeping an orphaned transcript alive in T3. Stop first so no run is holding a thread.
            await engine.stop(id).catch(() => {});
            // T3 settles a stop asynchronously; deleting a thread in the same tick can be refused.
            await new Promise((resolve) => setTimeout(resolve, 300));
            // Read again: a member thread may have been launched while the stop settled.
            const threads = await deleteThreads((await rooms.get(id)) ?? room);
            await rooms.remove(id);
            return send(res, 200, { ok: true, threads }), true;
          }
          return send(res, 405, { error: "method not allowed" }), true;
        }

        if (action === "messages" && method === "POST") {
          const body = ((await readBody(req)) ?? {}) as RoomMessage;
          const text = typeof body.text === "string" ? body.text : "";
          const attachments = validateAttachments((body as { attachments?: unknown }).attachments);
          if (!text.trim() && !attachments.length && !body.mentions?.length) return send(res, 400, { error: "a message needs text or a file" }), true;
          if (text.length > MAX_MESSAGE) return send(res, 400, { error: `the message is longer than ${MAX_MESSAGE} characters` }), true;
          const result = await engine.send(id, { text, mentions: Array.isArray(body.mentions) ? body.mentions : undefined, replyTo: body.replyTo ?? null, attachments });
          return send(res, 202, result, { "cache-control": "no-store" }), true;
        }

        if (action === "stop" && method === "POST") {
          const stopped = await engine.stop(id);
          return send(res, 200, { ok: stopped }), true;
        }

        if (action === "reset" && method === "POST") {
          // A turn in flight belongs to the conversation being thrown away.
          await engine.stop(id).catch(() => {});
          // T3 settles a stop asynchronously; the next dispatch must not find a dying run.
          await new Promise((resolve) => setTimeout(resolve, 300));
          // The threads stay: their ids are the room's, and a fresh session is what forgets the talk.
          let latest = await rooms.clearTurns(id);
          // A thread T3 no longer has cannot be freshened, so that member gets a new one.
          const missing: string[] = [];
          for (const member of latest.members) {
            if (!member.threadId) { missing.push(member.slug); continue; }
            const projection = await rpc.call("orchestration.getThreadProjection", { threadId: member.threadId }).catch(() => null) as { thread?: unknown } | null;
            if (!projection?.thread) missing.push(member.slug);
          }
          for (const slug of missing) latest = await rooms.setMember(id, slug, { threadId: null, status: "pending" });
          if (missing.length > 0) latest = await launchMembers(latest, missing, roster);
          // A started-over room picks up the room's current model and each Bot's current mode, the
          // way relaunching the threads used to. Failures are logged, not fatal: the reset still runs.
          const defaults = await launch();
          for (const member of latest.members) {
            const bot = roster.get(member.slug);
            let patch: Partial<RoomMember> = { fresh: true };
            if (member.threadId && bot) {
              try {
                const resolved = await resolveMemberLaunch({ rpc, bot: bot as RoomBot, settings: latest.settings, defaults });
                if (resolved.runtimeMode !== member.runtimeMode) {
                  await rpc.dispatch({ type: "thread.runtime-mode.set", threadId: member.threadId, runtimeMode: resolved.runtimeMode });
                }
                if (JSON.stringify(resolved.modelSelection ?? null) !== JSON.stringify(member.model ?? null) && resolved.modelSelection) {
                  await rpc.dispatch({ type: "thread.model-selection.set", threadId: member.threadId, modelSelection: resolved.modelSelection });
                }
                patch = { ...patch, runtimeMode: resolved.runtimeMode, model: resolved.modelSelection };
              } catch (err) {
                log(`[rooms] could not refresh ${member.slug}: ${(err as Error).message}`);
              }
            }
            latest = await rooms.setMember(id, member.slug, patch);
          }
          return send(res, 200, { room: await view(latest, roster) }, { "cache-control": "no-store" }), true;
        }

        return send(res, 404, { error: "no such route" }), true;
      } catch (err) {
        // RoomsError carries its own status; requireJson and the body reader reject with one too.
        const status = typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : err instanceof RoomsError ? err.status : 500;
        if (status >= 500) log(`[rooms] ${method} ${path}: ${(err as Error).message}`);
        return send(res, status, { error: (err as Error).message ?? "rooms failed" }), true;
      }
    },
  };
}

export type RoomRoutes = ReturnType<typeof createRoomRoutes>;
