import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "provider-instance-icon-test-entry",
    resolveId: (id) => id.endsWith("virtual:provider-instance-icon-test") ? "\0provider-instance-icon-test" : undefined,
    load: (id) => id === "\0provider-instance-icon-test" ? `
      export { createElement as h } from "react";
      export { renderToStaticMarkup } from "react-dom/server";
      export * from ${JSON.stringify(`${src}components/ProviderInstanceIcon.tsx`)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:provider-instance-icon-test", write: false },
});

const dir = await mkdtemp(join(tmpdir(), "bot-provider-icon-"));
const file = join(dir, "entry.mjs");
await writeFile(file, entryChunk(bundle).code);
const {
  h,
  renderToStaticMarkup,
  ProviderInstanceIcon,
  PROVIDER_ICON_BY_DRIVER,
  providerInstanceInitials,
} = await import(pathToFileURL(file).href);
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("providerInstanceInitials extracts two-letter uppercase abbreviations cleanly", () => {
  assert.equal(providerInstanceInitials(""), "");
  assert.equal(providerInstanceInitials("Codex"), "CO");
  assert.equal(providerInstanceInitials("Claude Code"), "CC");
  assert.equal(providerInstanceInitials("Codex (hub)"), "CH");
  assert.equal(providerInstanceInitials("'Grok'"), "GR");
  assert.equal(providerInstanceInitials("A"), "A");
});

test("PROVIDER_ICON_BY_DRIVER defines icons for all built-in T3 Code drivers", () => {
  const expectedDrivers = [
    "codex",
    "claudeAgent",
    "acpRegistry",
    "antigravity",
    "pi",
    "cursor",
    "opencode",
    "grok",
    "muse",
    "kiro",
    "fx",
  ];
  for (const driver of expectedDrivers) {
    assert.ok(PROVIDER_ICON_BY_DRIVER[driver], `Driver ${driver} must have an icon defined in PROVIDER_ICON_BY_DRIVER`);
  }
});

test("every built-in T3 driver renders an SVG icon and avoids the initials fallback", () => {
  const drivers: Array<{ driver: string; displayName: string }> = [
    { driver: "codex", displayName: "Codex" },
    { driver: "claudeAgent", displayName: "Claude" },
    { driver: "acpRegistry", displayName: "ACP Registry" },
    { driver: "antigravity", displayName: "Antigravity" },
    { driver: "pi", displayName: "Pi" },
    { driver: "cursor", displayName: "Cursor" },
    { driver: "opencode", displayName: "OpenCode" },
    { driver: "grok", displayName: "Grok" },
    { driver: "muse", displayName: "Muse Code" },
    { driver: "kiro", displayName: "Kiro" },
    { driver: "fx", displayName: "fx" },
  ];

  for (const { driver, displayName } of drivers) {
    const html = renderToStaticMarkup(h(ProviderInstanceIcon, { driver, displayName }));
    assert.ok(html.includes("<svg"), `Driver ${driver} should render an SVG element`);
    assert.ok(html.includes('aria-hidden="true"'), `Driver ${driver} should hide the decorative SVG from aria`);
    assert.ok(!html.includes("text-[9px]"), `Driver ${driver} should not display fallback initials span`);
  }
});

test("antigravity renders the official Antigravity image icon", () => {
  const html = renderToStaticMarkup(h(ProviderInstanceIcon, { driver: "antigravity", displayName: "Antigravity" }));
  assert.ok(html.includes("<image"), "Antigravity icon should contain an image element");
  assert.ok(html.includes("data:image/png;base64,"), "Antigravity icon should contain the base64 PNG data URL");
});

test("pi renders the SVG paths", () => {
  const html = renderToStaticMarkup(h(ProviderInstanceIcon, { driver: "pi", displayName: "Pi" }));
  assert.ok(html.includes('viewBox="165.29 165.29 469.43 469.43"'), "Pi icon should render the T3 viewBox");
  assert.ok(html.includes("<path"), "Pi icon should contain path elements");
});

test("unknown drivers fall back to rendering initials without an SVG", () => {
  const html = renderToStaticMarkup(h(ProviderInstanceIcon, { driver: "unknown_custom_driver", displayName: "Custom Model" }));
  assert.ok(!html.includes("<svg"), "Unknown driver should not render an SVG element");
  assert.ok(html.includes("CM"), "Unknown driver should render initials CM");
});

test("custom className and iconClassName are forwarded properly", () => {
  const withCustom = renderToStaticMarkup(h(ProviderInstanceIcon, {
    driver: "pi",
    displayName: "Pi",
    className: "custom-container",
    iconClassName: "size-4 custom-icon",
  }));
  assert.ok(withCustom.includes("custom-container"), "Container should include custom-container");
  assert.ok(withCustom.includes("custom-icon"), "Icon should include custom-icon");

  const fallbackWithCustom = renderToStaticMarkup(h(ProviderInstanceIcon, {
    driver: "custom",
    displayName: "Custom",
    className: "custom-fallback-container",
    iconClassName: "custom-fallback-text",
  }));
  assert.ok(fallbackWithCustom.includes("custom-fallback-container"));
  assert.ok(fallbackWithCustom.includes("custom-fallback-text"));
});
