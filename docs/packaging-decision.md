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

Threebot now packages for Windows as a first-class target:

- `install.ps1` installs a release under `%THREEBOT_HOME%\runtime\versions` and
  creates a `threebot.cmd` launcher (uses junctions, no elevation required).
- `server/service.mts` supports Windows via Task Scheduler (hidden, restart on
  failure, runs at logon) through `threebot up` / `threebot service`.
- PATH/node resolution and `findT3` handle Windows drive letters and `.cmd`
  launchers; `swapLink` uses junctions on Windows.
- `windows/` provides an optional Edge app-mode launcher and an optional native
  WebView2 shell (Rust + `wry`, requires MSVC build tools).

Install on Windows:

```powershell
irm https://raw.githubusercontent.com/RokaSwK/threebot/main/install.ps1 | iex
threebot up
```
