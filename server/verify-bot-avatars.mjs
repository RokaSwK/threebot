// Read-only verification against the live T3 projects and the favicon assets it serves.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBotAvatar } from "./bot-avatar.mjs";
import { T3Client, loadToken } from "./t3rpc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const botsRoot = process.env.BOTS_ROOT ?? `${process.env.HOME}/.treebot/bots`;
const client = new T3Client({
  baseUrl: process.env.T3_URL ?? "http://127.0.0.1:3773",
  token: loadToken(process.env.T3_TOKEN_FILE ?? path.join(here, ".t3-token")),
});
try {
  await client.connect();
  const { projects } = await client.http("/api/projects");
  let verified = 0;
  for (const project of projects) {
    if (project.deletedAt !== null || !project.workspaceRoot.startsWith(botsRoot + "/")) continue;
    const bot = await readFile(path.join(project.workspaceRoot, ".bot/bot.json"), "utf8")
      .then(JSON.parse).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    if (!bot) continue;
    assert.equal(project.title, bot.name);
    assert.equal(project.projectIcon, null);
    assert.match(project.faviconPath, /^\.bot\/avatar-[a-f0-9]{12}\.svg$/);
    const expected = renderBotAvatar(bot);
    assert.equal(await readFile(path.join(project.workspaceRoot, project.faviconPath), "utf8"), expected);
    const asset = await client.call("assets.createUrl", {
      resource: { _tag: "project-favicon", cwd: project.workspaceRoot, path: project.faviconPath },
    });
    const response = await fetch(new URL(asset.relativeUrl, client.baseUrl), {
      headers: { authorization: `Bearer ${client.token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    assert.equal(await response.text(), expected);
    console.log(`Verified ${bot.name}: ${project.faviconPath}`);
    verified++;
  }
  assert.ok(verified > 0, "No active Bot projects found");
  console.log(`Verified ${verified} live Bot project favicons.`);
} finally {
  client.close();
}
