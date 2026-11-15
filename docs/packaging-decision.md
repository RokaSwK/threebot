# Packaging decision: standalone companion app

Threebot stays a **standalone companion application**, not a T3 Code plugin or
extension.

## Why not a plugin/extension

- T3 Code exposes no plugin or extension host: there is no `t3 plugin install`
  command, no extension manifest, and no in-process extension API in the CLI or
  desktop app. The supported integration surface is T3 Code's HTTP API and MCP,
  which Threebot already uses.
- Threebot is a long-running Node gateway with its own web UI (PWA), background
  service, updater, remote access (Tailscale/Cloudflare), encrypted vault and
  notification pipeline. Forcing that into T3 Code's Electron process would
  couple release cadences and make Windows/macOS/Linux packaging depend on T3
  Code's internals.
- Running standalone keeps Threebot's release and update loop independent while
  still using only normal T3 threads/projects, so any Bot stays openable in
  T3 Code at any time.

## Windows packaging

Threebot packages for Windows as a first-class target, and Windows asks for no
elevation at any point.

- The portable bundle (`windows/build-bundle.ps1`) is the download: `Threebot.exe`,
  `app\` and a bundled Node. The first run copies the app to
  `%LOCALAPPDATA%\Programs\Threebot`, adds Start Menu and Startup shortcuts with
  Threebot's icon, starts the gateway and only then opens the app window.
- `Threebot.exe` is a Go launcher (`windows/launcher`), so building it needs no
  Visual Studio; `rsrc` compiles `threebot.ico` into the exe.
- `server/service.mts` starts the gateway from the per-user Startup folder.
  Task Scheduler was the first design and is gone: creating a task needs an
  elevated token on locked-down machines. The gateway writes `gateway.pid`, which
  is how a restart or an upgrade stops the old process.
- `install.ps1` still works for a release installed under
  `%THREEBOT_HOME%\runtime\versions`; `threebot up` writes the same runner script
  and Startup shortcut. Junctions stand in for symlinks, and PATH/node/`t3`
  lookups understand drive letters, `node.exe` and `.cmd` launchers.
- `run()` starts `.cmd`/`.bat` through `cmd.exe /d /s /c`: Node refuses to spawn
  them directly with `EINVAL`, which is what made `threebot up` die while asking
  T3 Code for a token.

Install on Windows:

```powershell
# portable bundle: unzip, then double-click Threebot.exe
# or from a checkout:
irm https://raw.githubusercontent.com/RokaSwK/threebot/main/install.ps1 | iex
threebot up
```
