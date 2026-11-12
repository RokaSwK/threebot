import assert from "node:assert/strict";
import test from "node:test";
import {
  isMentionBoundary,
  isNameContinuation,
  mentionQueryAt,
  mentionSegments,
  mentionsInText,
} from "./mention-rules.mts";

test("isMentionBoundary identifies valid and invalid boundaries", () => {
  assert.equal(isMentionBoundary("@foo", 0), true);
  assert.equal(isMentionBoundary(" @foo", 1), true);
  assert.equal(isMentionBoundary("(@foo", 1), true);
  assert.equal(isMentionBoundary('"@foo', 1), true);
  assert.equal(isMentionBoundary("[@foo", 1), true);
  assert.equal(isMentionBoundary("*@foo", 1), true);
  assert.equal(isMentionBoundary(".@foo", 1), true);

  // Invalid boundaries: word chars, email, url, double @
  assert.equal(isMentionBoundary("foo@bar", 3), false);
  assert.equal(isMentionBoundary("a@b.com", 1), false);
  assert.equal(isMentionBoundary("https://x/@y", 10), false);
  assert.equal(isMentionBoundary("@@foo", 1), false);
  assert.equal(isMentionBoundary("foo_@bar", 4), false);
});

test("isNameContinuation detects word characters following a match", () => {
  assert.equal(isNameContinuation(""), false);
  assert.equal(isNameContinuation(" "), false);
  assert.equal(isNameContinuation(","), false);
  assert.equal(isNameContinuation("!"), false);
  assert.equal(isNameContinuation("abc"), true);
  assert.equal(isNameContinuation("123"), true);
  assert.equal(isNameContinuation("_foo"), true);
  assert.equal(isNameContinuation("á"), true);
});

test("mentionQueryAt extracts query at boundary", () => {
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQueryAt("hello @Bo", 9), { start: 6, query: "Bo" });
  assert.deepEqual(mentionQueryAt("(@Bo", 4), { start: 1, query: "Bo" });
  assert.deepEqual(mentionQueryAt('"@Bo', 4), { start: 1, query: "Bo" });

  // Invalid: email, url, mid-word
  assert.equal(mentionQueryAt("foo@bar", 7), null);
  assert.equal(mentionQueryAt("a@b.com", 7), null);
  assert.equal(mentionQueryAt("https://x/@y", 12), null);
});

test("mentionQueryAt closes on newline or > 32 characters", () => {
  // Newline
  assert.equal(mentionQueryAt("@abc\ndef", 8), null);
  // Exactly 32 chars is ok
  const q32 = "a".repeat(32);
  assert.deepEqual(mentionQueryAt(`@${q32}`, 33), { start: 0, query: q32 });
  // 33 chars closes
  const q33 = "a".repeat(33);
  assert.equal(mentionQueryAt(`@${q33}`, 34), null);
});

test("mentionQueryAt returns no query for completed @Name ", () => {
  assert.equal(mentionQueryAt("hello @Bolt ", 12, ["Bolt"]), null);
  assert.deepEqual(mentionQueryAt("hello @Bolt", 11, ["Bolt"]), { start: 6, query: "Bolt" });
});

test("mentionsInText matches longest name first", () => {
  const names = ["Bob", "Bob Ross"];
  assert.deepEqual(mentionsInText("Hi @Bob Ross and @Bob!", names, "anywhere"), ["Bob Ross", "Bob"]);
  assert.deepEqual(mentionsInText("Hi @Bob", names, "anywhere"), ["Bob"]);
  assert.deepEqual(mentionsInText("Hi @Bobby", names, "anywhere"), []);
});

test("mentionsInText ignores code fences and inline code", () => {
  const text = `
Hello @Bolt! Check this: \`@Max\` and:
\`\`\`
@Alice and @Bob
\`\`\`
Finally @Sam.
`;
  const names = ["Bolt", "Max", "Alice", "Bob", "Sam"];
  assert.deepEqual(mentionsInText(text, names, "anywhere"), ["Bolt", "Sam"]);
});

test("mentionsInText respects leading policy", () => {
  const names = ["Alpha", "Beta", "Gamma"];
  assert.deepEqual(
    mentionsInText("@Alpha, @Beta and @Gamma: review this", names, "leading"),
    ["Alpha", "Beta", "Gamma"]
  );
  assert.deepEqual(
    mentionsInText("@Alpha & @Beta what do you think?", names, "leading"),
    ["Alpha", "Beta"]
  );
  assert.deepEqual(
    mentionsInText("Hello @Alpha", names, "leading"),
    []
  );
  assert.deepEqual(
    mentionsInText("@Alpha hello @Beta", names, "leading"),
    ["Alpha"]
  );
});

test("mentionsInText recognizes @all", () => {
  const names = ["Bolt", "Max"];
  assert.deepEqual(mentionsInText("Calling @all to review", names, "anywhere"), ["all"]);
  assert.deepEqual(mentionsInText("@all: standup time", names, "leading"), ["all"]);
});

test("mentionSegments splits text into plain runs and bots", () => {
  const names = ["Bolt", "Max"];
  assert.deepEqual(mentionSegments("Hola @Max, ¿ping?", names), [
    { text: "Hola " },
    { text: "@Max", bot: "Max" },
    { text: ", ¿ping?" },
  ]);

  // No mentions: a single run with the original text.
  assert.deepEqual(mentionSegments("Hola equipo", names), [{ text: "Hola equipo" }]);

  // Different casing resolves to the canonical name.
  assert.deepEqual(mentionSegments("@max ping", names), [
    { text: "@max", bot: "Max" },
    { text: " ping" },
  ]);
});

test("mentionSegments respects word boundaries, multi-word names and code", () => {
  const names = ["Bolt", "Max", "Max Power"];

  // The longest name wins.
  assert.deepEqual(mentionSegments("@Max Power hola", names), [
    { text: "@Max Power", bot: "Max Power" },
    { text: " hola" },
  ]);

  // "@Maxine" is not a mention of Max (word continuation).
  assert.deepEqual(mentionSegments("@Maxine hola", names), [{ text: "@Maxine hola" }]);

  // Emails and URLs are not mentions.
  assert.deepEqual(mentionSegments("escribe a foo@Max.com", names), [{ text: "escribe a foo@Max.com" }]);

  // No mentions inside code, and the code survives verbatim.
  assert.deepEqual(mentionSegments("mira `@Max` aqui", names), [{ text: "mira `@Max` aqui" }]);
  assert.deepEqual(mentionSegments("```\n@Max\n```\nfuera @Max", names), [
    { text: "```\n@Max\n```\nfuera " },
    { text: "@Max", bot: "Max" },
  ]);
});
