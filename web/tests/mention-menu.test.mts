import assert from "node:assert/strict";
import test from "node:test";
import {
  activeMentionQuery,
  mentionSuggestions,
  shouldSendOnEnter,
  withMention,
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

test("withMention preserves text before and after, appends one space, and updates cursor", () => {
  const bot: MentionBot = { slug: "bolt", name: "Bolt", label: "Code reviewer" };
  const draft = "Hello @Bo and welcome";
  const cursor = 9; // right after "Bo"

  const res = withMention(draft, cursor, bot);
  assert.equal(res.value, "Hello @Bolt and welcome");
  assert.equal(res.cursor, 12); // "Hello @Bolt " length is 12
});

test("withMention supports names with spaces", () => {
  const bot: MentionBot = { slug: "bob-ross", name: "Bob Ross", label: "Painter" };
  const draft = "Ask @Bob";
  const cursor = 8;

  const res = withMention(draft, cursor, bot);
  assert.equal(res.value, "Ask @Bob Ross ");
  assert.equal(res.cursor, 14);
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
});

test("shouldSendOnEnter is false only when menu has a selection", () => {
  assert.equal(shouldSendOnEnter(true), false);
  assert.equal(shouldSendOnEnter(false), true);
});
