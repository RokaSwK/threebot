/** Keep in sync with `INSTRUCTION_LIMITS.customChars` in server/instructions.mts. */
export const BOT_INSTRUCTIONS_MAX = 12_000;

/** The optional details the Create New Bot dialog asks for, in the owner's words. */
export type NewBotDetails = { does?: string; doesNot?: string; style?: string };

/**
 * Turns the dialog's three short answers into the owner's part of AGENTS.md.
 * The one-line role is not duplicated here: it already reaches the Bot as its label.
 */
export function composeBotInstructions(details: NewBotDetails): string {
  const sections: [string, string][] = [
    ["What this Bot does", details.does?.trim() ?? ""],
    ["What this Bot doesn't do", details.doesNot?.trim() ?? ""],
    ["How this Bot talks", details.style?.trim() ?? ""],
  ];
  const written = sections.filter(([, body]) => body !== "");
  return written.length === 0 ? "" : `${written.map(([title, body]) => `## ${title}\n${body}`).join("\n\n")}\n`;
}
