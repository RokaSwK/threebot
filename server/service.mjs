// The gateway as a background service, like T3 Code's: a launchd agent on macOS and a systemd user
// unit on Linux. It runs `threebot serve` from the `current` runtime link (or a source checkout),
// so an update only swaps the link and restarts the service.
import { existsSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { run } from "./release.mjs";

export const LAUNCHD_LABEL = "tools.threebot.gateway";
export const SYSTEMD_UNIT = "threebot.service";

const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The node to run: the PATH entry that is this same node (/opt/homebrew/bin/node), not the
 * versioned folder it resolves to, which disappears when Homebrew or nvm upgrades Node.
 */
export function stableNode(execPath = process.execPath, pathEnv = process.env.PATH ?? "") {
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "node");
    if (existsSync(candidate) && real(candidate) === target) return candidate;
  }
  return execPath;
}

/** Everything a service needs to know: what to run, with which environment, and where logs go. */
export function serviceSpec({ node = stableNode(), cli, home, pathEnv = process.env.PATH ?? "", label = LAUNCHD_LABEL, unit = SYSTEMD_UNIT }) {
  // A service starts with a bare PATH; keep the user's, so `t3`, `tailscale` and `cloudflared` are found.
  const dirs = [...new Set([path.dirname(node), ...pathEnv.split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/bin"])];
  return { node, cli, home, label, unit, env: { PATH: dirs.join(":"), THREEBOT_HOME: home, THREEBOT_SERVICE: "1" }, log: path.join(home, "logs", "gateway.log") };
}

export function launchdPlist(spec) {
  const env = Object.entries(spec.env).map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.node)}</string>
      <string>${xml(spec.cli)}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>WorkingDirectory</key><string>${xml(spec.home)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>${xml(spec.log)}</string>
    <key>StandardErrorPath</key><string>${xml(spec.log)}</string>
  </dict>
</plist>
`;
}

const quoteUnit = (value) => /[\s"\\]/.test(value) ? `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
export function systemdUnit(spec) {
  return `[Unit]
Description=Threebot
After=network-online.target

[Service]
ExecStart=${[spec.node, spec.cli, "serve"].map(quoteUnit).join(" ")}
WorkingDirectory=${quoteUnit(spec.home)}
${Object.entries(spec.env).map(([k, v]) => `Environment=${quoteUnit(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=5
StandardOutput=append:${spec.log}
StandardError=append:${spec.log}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(spec, platform = process.platform) {
  if (platform === "darwin") return path.join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
  if (platform === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user", spec.unit);
  return null;
}

export const serviceSupported = (platform = process.platform) => platform === "darwin" || platform === "linux";
const domain = () => `gui/${userInfo().uid}`;

export async function installService(spec, { platform = process.platform, exec = run } = {}) {
  if (!serviceSupported(platform)) throw new Error("Background services are supported on macOS and Linux.");
  const file = serviceFile(spec, platform);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(spec.log), { recursive: true });
  if (platform === "darwin") {
    await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
    await fs.writeFile(file, launchdPlist(spec));
    await exec("launchctl", ["enable", `${domain()}/${spec.label}`]).catch(() => {});
    await exec("launchctl", ["bootstrap", domain(), file]);
  } else {
    await fs.writeFile(file, systemdUnit(spec));
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", spec.unit]);
  }
  return file;
}

export async function uninstallService(spec, { platform = process.platform, exec = run } = {}) {
  const file = serviceFile(spec, platform);
  if (platform === "darwin") await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
  if (platform === "linux") await exec("systemctl", ["--user", "disable", "--now", spec.unit]).catch(() => {});
  if (file) await fs.rm(file, { force: true });
  if (platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
}

export async function restartService(spec, { platform = process.platform, exec = run } = {}) {
  if (platform === "darwin") return exec("launchctl", ["kickstart", "-k", `${domain()}/${spec.label}`]);
  if (platform === "linux") return exec("systemctl", ["--user", "restart", spec.unit]);
  throw new Error("Background services are supported on macOS and Linux.");
}

export function serviceInstalled(spec, platform = process.platform) {
  const file = serviceFile(spec, platform);
  return Boolean(file && existsSync(file));
}
