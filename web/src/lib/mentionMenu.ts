import { mentionQueryAt } from "../../../server/mention-rules.mts";

export type MentionBot = {
  slug: string;
  name: string;
  label: string;
  hidden?: boolean;
  shape?: string;
  color?: string;
  avatarImage?: string | null;
};

export type MentionQuery = {
  start: number;
  query: string;
};

/**
 * Suggestions for an @ query. Only non-hidden bots with names.
 * Ranked: case-insensitive `startsWith` first, then `includes`, sorted alphabetically, capped at 8.
 */
export function mentionSuggestions(query: string, bots: MentionBot[]): MentionBot[] {
  const visible = bots.filter((b) => !b.hidden && b.name.trim().length > 0);
  const q = query.toLowerCase();

  if (q.trim() === "") {
    return [...visible].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
  }

  const startsWithList: MentionBot[] = [];
  const includesList: MentionBot[] = [];

  for (const b of visible) {
    const nameLower = b.name.toLowerCase();
    if (nameLower.startsWith(q)) {
      startsWithList.push(b);
    } else if (nameLower.includes(q)) {
      includesList.push(b);
    }
  }

  startsWithList.sort((a, b) => a.name.localeCompare(b.name));
  includesList.sort((a, b) => a.name.localeCompare(b.name));

  return [...startsWithList, ...includesList].slice(0, 8);
}

/**
 * Returns the query at `cursor`, or null if no query or if the mention is complete
 * (e.g. text from `@` to cursor is exactly `@Name ` for a visible bot).
 */
export function activeMentionQuery(text: string, cursor: number, bots: MentionBot[]): MentionQuery | null {
  const visibleNames = bots.filter((b) => !b.hidden && b.name.trim().length > 0).map((b) => b.name);
  const q = mentionQueryAt(text, cursor, visibleNames);
  if (!q) return null;

  const textFromAt = text.slice(q.start, cursor).toLowerCase();
  for (const name of visibleNames) {
    const complete = `@${name.toLowerCase()} `;
    if (!textFromAt.startsWith(complete)) continue;
    // A complete name plus a space ends the mention; from there the user is writing prose and the
    // menu has nothing to offer. The one exception: while what they typed can still grow into a
    // longer visible name (a Bot called "Max" next to one called "Max Power"), keep it open.
    const typed = textFromAt.slice(1);
    const canGrow = visibleNames.some((other) => {
      const candidate = other.toLowerCase();
      return candidate.length > typed.length && candidate.startsWith(typed);
    });
    if (!canGrow) return null;
  }

  return q;
}

/**
 * Inserts `@Name ` in place of the query range [start, cursor) and returns the new value and cursor.
 */
export function withMention(draft: string, cursor: number, bot: MentionBot): { value: string; cursor: number } {
  const q = mentionQueryAt(draft, cursor);
  const start = q ? q.start : cursor;
  const prefix = draft.slice(0, start);
  let suffix = draft.slice(cursor);
  if (suffix.startsWith(" ")) {
    suffix = suffix.slice(1);
  }
  const insert = `@${bot.name} `;
  return {
    value: prefix + insert + suffix,
    cursor: start + insert.length,
  };
}

/** False only when the menu has a selectable row. */
export function shouldSendOnEnter(menuHasSelection: boolean): boolean {
  return !menuHasSelection;
}
