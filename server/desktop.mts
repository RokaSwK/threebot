// Settings → Computer → Remote desktop: a desktop the Bots share (for example noVNC on a virtual
// screen), shown in the Computer view instead of T3's browser, with the user's note on how Bots drive it.

/** As stored in settings.json. Null means the Bots use T3's browser. */
export type Desktop = { url: string; howTo: string };

const HOW_TO_LIMIT = 4000;

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Validates a `desktop` settings patch: an http(s) address without credentials, and a plain-text note. */
export function desktopPatch(value: unknown): Desktop | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw bad("desktop must be an object or null");
  const raw = value as { url?: unknown; howTo?: unknown };
  if (typeof raw.url !== "string" || !raw.url.trim()) throw bad("Enter the remote desktop's web address");
  let url: URL;
  try { url = new URL(raw.url.trim()); } catch { throw bad("Enter a web address using http or https"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw bad("Enter a web address using http or https, without a username or password");
  if (raw.howTo !== undefined && typeof raw.howTo !== "string") throw bad("howTo must be text");
  const howTo = (raw.howTo ?? "").trim();
  if (howTo.length > HOW_TO_LIMIT) throw bad(`Keep the note under ${HOW_TO_LIMIT} characters`);
  return { url: url.href, howTo };
}

/** The lines of a Bot's "Computer" section that say which screen it works on. */
export function desktopLines(desktop: Desktop | null | undefined, userName: string): string {
  if (!desktop) return "Use the T3 browser tools (`preview_open`, `preview_act`, `preview_snapshot`, …); keep one tab per task and reuse it.";
  return `Your screen is a remote desktop that ${userName} watches and takes over in the Computer view (${desktop.url}). Do browser and app work there, not in the T3 browser. Use the T3 browser tools only to fill Vault logins, since the Vault types into that browser alone.${desktop.howTo ? `\n- How to drive the remote desktop, from ${userName}:\n\n${desktop.howTo.split("\n").map((line) => `  ${line}`).join("\n")}\n` : ` ${userName} hasn't said how to drive it yet; ask once, then keep the answer in your memory.`}`;
}
