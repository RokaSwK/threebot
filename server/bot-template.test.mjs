import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAgentsMd } from "./bot-template.mjs";

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
