/**
 * The page's notifications. `web/src/sw.ts` builds the same options for a push but cannot import
 * this file: the worker is emitted as a classic script with no imports. Keep the two in sync; the
 * page test and the worker test assert the same fields.
 */
export type NotificationPayload = {
  title?: unknown;
  body?: unknown;
  tag?: unknown;
  url?: unknown;
  icon?: unknown;
  badge?: unknown;
  timestamp?: unknown;
};

/** The DOM lib in this toolchain predates `timestamp`; the browsers support it. */
export type NotificationViewOptions = NotificationOptions & { timestamp?: number };

export type NotificationContent = { title: string; options: NotificationViewOptions };

/** Defaults and guards for a notification the page shows (the worker has its own copy). */
export function notificationContent(payload: NotificationPayload): NotificationContent {
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "threebot";
  const options: NotificationViewOptions = {
    body: typeof payload.body === "string" ? payload.body : "Finished",
    tag,
    icon: typeof payload.icon === "string" && payload.icon ? payload.icon : "/icon-192.png",
    data: { url: typeof payload.url === "string" ? payload.url : "./" },
  };
  if (typeof payload.badge === "string" && payload.badge) options.badge = payload.badge;
  if (typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)) options.timestamp = payload.timestamp;
  return { title: typeof payload.title === "string" && payload.title ? payload.title : "Threebot", options };
}

/** One notification per conversation for something that needs the user; one per Bot for a completion. */
export function waitingTag(slug: string, threadId: string): string {
  return `waiting:${slug}:${threadId}`;
}

export function notificationTarget(slug: string, kind: "finished" | "waiting", threadId: string): { tag: string; url: string } {
  const bot = encodeURIComponent(slug);
  return kind === "waiting"
    ? { tag: waitingTag(slug, threadId), url: `/?bot=${bot}&thread=${encodeURIComponent(threadId)}` }
    : { tag: slug, url: `/?bot=${bot}` };
}

/** A photo has no silhouette worth drawing on Android's status bar, so it keeps the app's badge. */
export function botBadge(bot: { slug: string; avatarImage?: string | null }): string | null {
  return typeof bot.avatarImage === "string" && bot.avatarImage ? null : `/api/bots/${encodeURIComponent(bot.slug)}/badge.png`;
}
