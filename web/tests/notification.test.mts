import assert from "node:assert/strict";
import test from "node:test";
import { botBadge, notificationContent, notificationTarget } from "../src/lib/notification.ts";

test("a waiting notification carries the Bot icon, badge, vibration and timestamp", () => {
  const { title, options } = notificationContent({
    title: "Alpha",
    body: "Waiting for you",
    tag: "waiting:alpha:thread-1",
    url: "/?bot=alpha&thread=thread-1",
    icon: "/api/bots/alpha/avatar.png",
    badge: "/api/bots/alpha/badge.png",
    timestamp: 1_700_000_000_000,
  });
  assert.equal(title, "Alpha");
  assert.equal(options.body, "Waiting for you");
  assert.equal(options.tag, "waiting:alpha:thread-1");
  assert.equal(options.icon, "/api/bots/alpha/avatar.png");
  assert.equal(options.badge, "/api/bots/alpha/badge.png");
  assert.equal(options.timestamp, 1_700_000_000_000);
  assert.deepEqual(options.data, { url: "/?bot=alpha&thread=thread-1" });
  assert.equal("renotify" in options, false, "a replacement stays quiet");
});

test("malformed extras are dropped instead of reaching the browser", () => {
  const { title, options } = notificationContent({
    tag: "",
    timestamp: Number.NaN,
    badge: 42,
  });
  assert.equal(title, "Threebot");
  assert.equal(options.tag, "threebot", "the tag is never empty");
  assert.equal(options.timestamp, undefined);
  assert.equal(options.badge, undefined);
  assert.equal(options.icon, "/icon-192.png");
});

test("one tag per waiting conversation, one per Bot for a completion", () => {
  assert.deepEqual(notificationTarget("alpha", "waiting", "thread-1"), {
    tag: "waiting:alpha:thread-1",
    url: "/?bot=alpha&thread=thread-1",
  });
  assert.deepEqual(notificationTarget("alpha", "finished", "thread-1"), {
    tag: "alpha",
    url: "/?bot=alpha",
  });
});

test("a photo has no monochrome badge; a drawn avatar does", () => {
  assert.equal(botBadge({ slug: "alpha" }), "/api/bots/alpha/badge.png");
  assert.equal(botBadge({ slug: "alpha", avatarImage: "/api/bots/alpha/avatar/abc.png" }), null);
});
