// HTTP routes for rooms. The caller has already checked the user is signed in.
//   GET    /api/rooms               summaries for the sidebar
//   POST   /api/rooms               create (2–8 Bots, launches one thread per member)
//   GET    /api/rooms/:id           the room, its members and the turn index
//   PATCH  /api/rooms/:id           change settings or membership
//   DELETE /api/rooms/:id           forget the room; every member thread stays in T3
//   POST   /api/rooms/:id/recreate  launch fresh member threads with the current settings
import type { IncomingHttpHeaders } from "node:http";
import {
  RoomsError, validateMembers, type BotIdentity, type Room, type RoomMember, type RoomsStore,
} from "./rooms.mts";
import { launchRoomThread, type LaunchDefaults, type RoomBot, type RoomRpc } from "./rooms-threads.mts";

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
};
export type RoomView = Omit<Room, "members"> & { members: MemberView[] };

export function createRoomRoutes<Req extends RoomsRequest, Res>({ rooms, rpc, bots, launch, send, readBody, requireJson, checkOrigin, log = () => {} }: {
  rooms: RoomsStore;
  /** The same T3 client the engine uses. */
  rpc: RoomRpc;
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

  async function view(room: Room): Promise<RoomView> {
    const roster = await bySlug();
    return {
      ...room,
      members: room.members.map((member) => {
        const bot = roster.get(member.slug);
        return {
          slug: member.slug,
          name: bot?.name ?? member.slug,
          label: bot?.label ?? "",
          color: bot?.color ?? "gray",
          shape: bot?.shape ?? "sphere",
          avatarImage: bot?.avatarImage ?? null,
          threadId: member.threadId,
          status: roster.has(member.slug) ? member.status : "unavailable",
          model: member.model,
          runtimeMode: member.runtimeMode,
          lastTurnAt: member.lastTurnAt,
        };
      }),
    };
  }

  async function summary(room: Room) {
    const full = await view(room);
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      section: room.section,
      pinned: room.pinned,
      mode: room.settings.mode,
      members: full.members.map(({ slug, name, label, color, shape, avatarImage }) => ({ slug, name, label, color, shape, avatarImage })),
      lastTurnAt: room.turns.at(-1)?.at ?? null,
      running: room.turns.some((turn) => turn.status === "running"),
    };
  }

  /** A new member gets a thread as soon as it is added; a failure leaves it `pending`. */
  async function launchMembers(room: Room, slugs: string[]): Promise<Room> {
    const roster = await bySlug();
    const defaults = await launch();
    let latest = room;
    for (const slug of slugs) {
      const bot = roster.get(slug);
      if (!bot) continue;
      try {
        const launched = await launchRoomThread({ rpc, room: latest, slug, bot: bot as RoomBot, settings: latest.settings, defaults });
        latest = await rooms.setMember(room.id, slug, {
          threadId: launched.threadId,
          status: "ready",
          model: launched.modelSelection,
          runtimeMode: launched.runtimeMode,
        });
      } catch (err) {
        log(`[rooms] could not launch ${slug}: ${(err as Error).message}`);
        latest = await rooms.setMember(room.id, slug, { status: "pending" });
      }
    }
    return latest;
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
            const list = await rooms.list();
            return send(res, 200, { rooms: await Promise.all(list.map(summary)) }, { "cache-control": "no-store" }), true;
          }
          if (method === "POST") {
            const body = (await readBody(req)) ?? {};
            const members = validateMembers(body.members, await bots());
            const created = await rooms.create({ ...body, members });
            const launched = await launchMembers(created, members.map((bot) => bot.slug));
            return send(res, 201, { room: await view(launched) }, { "cache-control": "no-store" }), true;
          }
          return send(res, 405, { error: "method not allowed" }), true;
        }

        if (!id) return send(res, 404, { error: "no such room" }), true;
        const room = await rooms.get(id);
        if (!room) return send(res, 404, { error: "no such room" }), true;

        if (!action) {
          if (method === "GET") return send(res, 200, { room: await view(room) }, { "cache-control": "no-store" }), true;
          if (method === "PATCH") {
            const body = (await readBody(req)) ?? {};
            const members = Array.isArray(body.members) ? validateMembers(body.members, await bots()) : null;
            const updated = await rooms.update(id, { ...body, ...(members ? { members: members.map((bot) => bot.slug) } : {}) });
            const pending = updated.members.filter((member) => !member.threadId).map((member) => member.slug);
            const launched = pending.length > 0 ? await launchMembers(updated, pending) : updated;
            return send(res, 200, { room: await view(launched) }, { "cache-control": "no-store" }), true;
          }
          if (method === "DELETE") {
            await rooms.remove(id);
            return send(res, 200, { ok: true }), true;
          }
          return send(res, 405, { error: "method not allowed" }), true;
        }

        if (action === "recreate" && method === "POST") {
          const body = (await readBody(req)) ?? {};
          const targets = typeof body.slug === "string" ? [body.slug] : room.members.map((member) => member.slug);
          let latest = room;
          for (const slug of targets) latest = await rooms.setMember(id, slug, { threadId: null, status: "pending" });
          const launched = await launchMembers(latest, targets);
          // Fresh threads mean a fresh conversation: the room's own index goes with them, or the page
          // would keep showing the user's messages from a conversation nobody can answer any more.
          const cleared = await rooms.clearTurns(id);
          return send(res, 200, { room: await view(cleared) }, { "cache-control": "no-store" }), true;
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
