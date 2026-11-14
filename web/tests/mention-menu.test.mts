import assert from "node:assert/strict";
import test from "node:test";
import {
  activeMentionQuery,
  mentionSuggestions,
  mentionEdit,
  type MentionBot,
} from "../src/lib/mentionMenu.ts";

const sampleBots: MentionBot[] = [
  { slug: "alpha", name: "Alpha", label: "First bot" },
  { slug: "beta", name: "Beta", label: "Second bot" },
  { slug: "bob-ross", name: "Bob Ross", label: "Painter" },
  { slug: "hidden", name: "Hidden Bot", label: "Ghost", hidden: true },
  { slug: "ralph", name: "Ralph", label: "Contains alph" },
];

test("mentionSuggestions filters case-insensitively, ranks startsWith before includes, and excludes hidden bots", () => {
  const res = mentionSuggestions("alph", sampleBots);
  // "Alpha" starts with "alph"; "Ralph" includes "alph"; "Hidden Bot" is hidden
  assert.equal(res.length, 2);
  assert.equal(res[0].name, "Alpha");
  assert.equal(res[1].name, "Ralph");
});

test("mentionSuggestions returns empty array for empty bot list", () => {
  assert.deepEqual(mentionSuggestions("a", []), []);
  assert.deepEqual(mentionSuggestions("", []), []);
});

test("mentionSuggestions caps at 8 and sorts alphabetically", () => {
  const bots: MentionBot[] = Array.from({ length: 15 }, (_, i) => ({
    slug: `bot-${String.fromCharCode(97 + i)}`,
    name: `Bot ${String.fromCharCode(97 + i).toUpperCase()}`,
    label: "test",
  }));
  const res = mentionSuggestions("", bots);
  assert.equal(res.length, 8);
  assert.equal(res[0].name, "Bot A");
  assert.equal(res[7].name, "Bot H");
});

// Apply the edit the composer makes when a Bot is picked.
const pick = (draft: string, cursor: number, bot: MentionBot) => {
  const edit = mentionEdit(draft, cursor, bot);
  return { value: draft.slice(0, edit.from) + edit.insert + draft.slice(edit.to), cursor: edit.from + edit.insert.length };
};

test("picking keeps the text around the query, adds one space and puts the caret after it", () => {
  const bot: MentionBot = { slug: "bolt", name: "Bolt", label: "Code reviewer" };
  assert.deepEqual(pick("Hello @Bo and welcome", 9, bot), { value: "Hello @Bolt and welcome", cursor: 12 });
});

test("picking supports names with spaces", () => {
  const bot: MentionBot = { slug: "bob-ross", name: "Bob Ross", label: "Painter" };
  assert.deepEqual(pick("Ask @Bob", 8, bot), { value: "Ask @Bob Ross ", cursor: 14 });
});

test("activeMentionQuery detects completed mention and closes", () => {
  const bots: MentionBot[] = [{ slug: "bolt", name: "Bolt", label: "Reviewer" }];
  assert.deepEqual(activeMentionQuery("Hello @Bo", 9, bots), { start: 6, query: "Bo" });
  assert.equal(activeMentionQuery("Hello @Bolt ", 12, bots), null);
});

test("activeMentionQuery closes once the mention is complete and prose follows", () => {
  // After "@Bolt " the user is writing prose: the menu has nothing to offer.
  assert.equal(activeMentionQuery("@Bolt please review", 20, [{ slug: "bolt", name: "Bolt", label: "" }]), null);
  // But if what they typed can still grow into another visible name, it stays open.
  const bots: MentionBot[] = [
    { slug: "max", name: "Max", label: "" },
    { slug: "max-power", name: "Max Power", label: "" },
  ];
  assert.deepEqual(activeMentionQuery("@Max P", 6, bots), { start: 0, query: "Max P" });
  assert.deepEqual(activeMentionQuery("@Max ", 5, bots), { start: 0, query: "Max " }, "the space after Max keeps Max Power on offer");
});
