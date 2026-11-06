import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAgentsMd } from "./bot-template.mts";

const render = (settings = {}) => renderAgentsMd({ bot: { name: "Roka", slug: "roka", projectId: "p", mainThreadId: "t" }, settings, botsRoot: "/bots" });

test("Bots can park threads and read what's parked across projects", () => {
  const text = render({ userName: "Sam", timezone: "Europe/Madrid" });
  assert.match(text, /`t3_thread_organize` with action `snooze` and `snoozedUntil`/);
  assert.match(text, /in Europe\/Madrid/);
  assert.match(text, /`t3_thread_list` with `allProjects: true`, plus `snoozed: true`/);
});

test("snooze times fall back to the server's clock", () => {
  assert.match(render(), /"9am" in the server's local time/);
});

test("routines start fresh each run when T3 offers it, unless they need the conversation", () => {
  assert.match(render(), /If the tool offers `freshSession`, set it to true/);
  assert.match(render(), /leave it off when a run needs the conversation so far/);
});
