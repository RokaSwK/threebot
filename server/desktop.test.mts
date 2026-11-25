import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopPatch } from "./desktop.mts";
import { renderAgentsMd } from "./bot-template.mts";

const render = (settings = {}) => renderAgentsMd({ bot: { name: "Roka", slug: "roka", projectId: "p", mainThreadId: "t" }, settings, botsRoot: "/bots" });

test("a remote desktop needs a plain http(s) address", () => {
  assert.deepEqual(desktopPatch({ url: " https://desk.example.ts.net:6080/vnc.html?autoconnect=1 ", howTo: " Use xdotool on :20. " }), { url: "https://desk.example.ts.net:6080/vnc.html?autoconnect=1", howTo: "Use xdotool on :20." });
  assert.equal(desktopPatch(null), null);
  for (const url of ["", "javascript:alert(1)", "file:///etc/passwd", "https://me:secret@desk.example", "not a url"]) assert.throws(() => desktopPatch({ url }), { status: 400 });
  assert.throws(() => desktopPatch({ url: "https://desk.example", howTo: 3 }), { status: 400 });
  assert.throws(() => desktopPatch({ url: "https://desk.example", howTo: "x".repeat(4001) }), { status: 400 });
  assert.throws(() => desktopPatch("https://desk.example"), { status: 400 });
});

test("Bots use T3's browser until a remote desktop is set, then the desktop and the user's note", () => {
  assert.match(render(), /Use the T3 browser tools \(`preview_open`/);
  const text = render({ userName: "Sam", desktop: { url: "https://desk.example/", howTo: "Drive Chrome over CDP at 127.0.0.1:9333.\nOther apps: DISPLAY=:20 xdotool." } });
  assert.match(text, /Your screen is a remote desktop that Sam watches and takes over in the Computer view \(https:\/\/desk\.example\/\)/);
  assert.match(text, /T3 browser tools only to fill Vault logins/);
  assert.match(text, /\n  Drive Chrome over CDP at 127\.0\.0\.1:9333\.\n  Other apps: DISPLAY=:20 xdotool\./);
  assert.match(render({ userName: "Sam", desktop: { url: "https://desk.example/", howTo: "" } }), /hasn't said how to drive it yet/);
});
