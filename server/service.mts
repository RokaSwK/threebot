// The gateway as a background service, like T3 Code's: a launchd agent on macOS and a systemd user
// unit on Linux. It runs `threebot serve` from the `current` runtime link (or a source checkout),
// so an update only swaps the link and restarts the service.
import { existsSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { run } from "./release.mts";

export const LAUNCHD_LABEL = "tools.threebot.gateway";
export const SYSTEMD_UNIT = "threebot.service";

const xml = (value: string) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The node to run: the PATH entry that is this same node (/opt/homebrew/bin/node), not the
 * versioned folder it resolves to, which disappears when Homebrew or nvm upgrades Node.
 */
export function stableNode(execPath: string = process.execPath, pathEnv: string = process.env.PATH ?? ""): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node", "node.exe"];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const nodeName of names) {
      const candidate = path.join(dir, nodeName);
      if (existsSync(candidate) && real(candidate) === target) return candidate;
    }
  }
  return execPath;
}

/** Everything a service needs to know: what to run, with which environment, and where logs go. */
export function serviceSpec({ node = stableNode(), cli, home, pathEnv = process.env.PATH ?? "", label = LAUNCHD_LABEL, unit = SYSTEMD_UNIT }: { node?: string; cli: string; home: string; pathEnv?: string; label?: string; unit?: string }) {
  // A service starts with a bare PATH; keep the user's, so `t3`, `tailscale` and `cloudflared` are found.
  const baseDirs = process.platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"];
  const dirs = [...new Set([path.dirname(node), ...pathEnv.split(path.delimiter).filter(Boolean), ...baseDirs])];
  return { node, cli, home, label, unit, env: { PATH: dirs.join(path.delimiter), THREEBOT_HOME: home, THREEBOT_SERVICE: "1" }, log: path.join(home, "logs", "gateway.log") };
}

export type ServiceSpec = ReturnType<typeof serviceSpec>;
type ServiceOptions = { platform?: NodeJS.Platform; exec?: typeof run };

export function launchdPlist(spec: ServiceSpec): string {
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

const quoteUnit = (value: string) => /[\s"\\]/.test(value) ? `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
export function systemdUnit(spec: ServiceSpec): string {
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

export function serviceFile(spec: ServiceSpec, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return path.join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
  if (platform === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user", spec.unit);
  if (platform === "win32") return path.join(spec.home, ".service-installed");
  return null;
}

export const serviceSupported = (platform = process.platform) => platform === "darwin" || platform === "linux" || platform === "win32";
const domain = () => `gui/${userInfo().uid}`;

/** The task name older Windows installs used; `up` removes it so the two never fight over the port. */
export const WINDOWS_TASK_NAME = "ThreebotGateway";

/**
 * Windows starts the gateway from the per-user Startup folder, not Task Scheduler: creating a task
 * needs an elevated token on locked-down machines, and a portable app must never ask for that.
 */
export function windowsRunnerPath(spec: ServiceSpec): string {
  return path.join(spec.home, "threebot-serve.cmd");
}

export function windowsRunnerScript(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `set "${k}=${v}"`);
  return ["@echo off", "setlocal", ...env,
    `"${spec.node}" "${spec.cli}" serve >> "${spec.log}" 2>&1`,
    "endlocal", ""].join("\r\n");
}

export const windowsPidPath = (spec: ServiceSpec) => path.join(spec.home, "gateway.pid");
const comspecPath = () => process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");

/** `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`, where Windows runs a shortcut at logon. */
export function windowsStartupDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export const windowsStartupShortcut = (spec: ServiceSpec) => path.join(windowsStartupDir(), "Threebot Gateway.lnk");

/** A .lnk pointing at a command, written through WScript.Shell (no extra dependency, no elevation). */
export async function createWindowsShortcut({ lnk, target, args = "", workdir, icon, description }: { lnk: string; target: string; args?: string; workdir?: string; icon?: string; description?: string }, exec: typeof run = run): Promise<string> {
  const q = (value: string) => `'${String(value).replace(/'/g, "''")}'`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.Arguments = ${q(args)}`,
    ...(workdir ? [`$s.WorkingDirectory = ${q(workdir)}`] : []),
    ...(icon ? [`$s.IconLocation = ${q(icon)}`] : []),
    ...(description ? [`$s.Description = ${q(description)}`] : []),
    "$s.WindowStyle = 7",
    "$s.Save()",
  ];
  await fs.mkdir(path.dirname(lnk), { recursive: true });
  const script = path.join(path.dirname(lnk), `.threebot-shortcut-${process.pid}.ps1`);
  await fs.writeFile(script, lines.join("\r\n") + "\r\n");
  try {
    await exec("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
  } finally {
    await fs.rm(script, { force: true });
  }
  return lnk;
}

/** Start the runner detached, with no console window, so `up` can return and the app keeps running. */
export async function startWindowsGateway(spec: ServiceSpec): Promise<void> {
  const runner = windowsRunnerPath(spec);
  if (!existsSync(runner)) throw new Error(`Threebot's runner script is missing: ${runner}`);
  const { spawn } = await import("node:child_process");
  const child = spawn(comspecPath(), ["/d", "/s", "/c", `""${runner}""`], {
    cwd: spec.home, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
    env: { ...process.env, ...spec.env },
  });
  child.unref();
}

export async function stopWindowsGateway(spec: ServiceSpec, exec: typeof run = run): Promise<void> {
  let pid = NaN;
  try { pid = Number((await fs.readFile(windowsPidPath(spec), "utf8")).trim()); } catch { /* never started */ }
  if (Number.isFinite(pid) && pid > 0) await exec("taskkill", ["/PID", String(pid), "/F"]).catch(() => {});
  await fs.rm(windowsPidPath(spec), { force: true });
}


export async function installService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<string> {
  if (!serviceSupported(platform)) throw new Error("Background services are supported on macOS and Linux.");
  const file = serviceFile(spec, platform)!;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(spec.log), { recursive: true });
  if (platform === "darwin") {
    await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
    await fs.writeFile(file, launchdPlist(spec));
    await exec("launchctl", ["enable", `${domain()}/${spec.label}`]).catch(() => {});
    await exec("launchctl", ["bootstrap", domain(), file]);
  } else if (platform === "linux") {
    await fs.writeFile(file, systemdUnit(spec));
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", spec.unit]);
  } else if (platform === "win32") {
    await fs.writeFile(windowsRunnerPath(spec), windowsRunnerScript(spec));
    await exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => {});
    await createWindowsShortcut({
      lnk: windowsStartupShortcut(spec),
      target: comspecPath(),
      args: `/d /s /c ""${windowsRunnerPath(spec)}""`,
      workdir: spec.home,
      description: "Threebot gateway",
    }, exec);
    await fs.writeFile(file, "");
    await stopWindowsGateway(spec, exec);
    await startWindowsGateway(spec);
  }
  return file;
}

export async function uninstallService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<void> {
  const file = serviceFile(spec, platform);
  if (platform === "darwin") await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
  if (platform === "linux") await exec("systemctl", ["--user", "disable", "--now", spec.unit]).catch(() => {});
  if (platform === "win32") {
    await stopWindowsGateway(spec, exec);
    await exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => {});
    await fs.rm(windowsStartupShortcut(spec), { force: true });
    await fs.rm(windowsRunnerPath(spec), { force: true });
  }
  if (file) await fs.rm(file, { force: true });
  if (platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
}

export async function restartService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<string> {
  if (platform === "darwin") return exec("launchctl", ["kickstart", "-k", `${domain()}/${spec.label}`]);
  if (platform === "linux") return exec("systemctl", ["--user", "restart", spec.unit]);
  if (platform === "win32") {
    await stopWindowsGateway(spec, exec);
    await new Promise((r) => setTimeout(r, 500));
    await startWindowsGateway(spec);
    return "Restarted";
  }
  throw new Error("Background services are not supported on this platform.");
}

export function serviceInstalled(spec: ServiceSpec, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return existsSync(windowsStartupShortcut(spec));
  const file = serviceFile(spec, platform);
  return Boolean(file && existsSync(file));
}
