# Threebot for Windows

Threebot on Windows is one portable folder: `Threebot.exe` plus the app it
carries. There is no installer and no admin prompt.

## Using the bundle

```
Threebot-<version>-win64\
├── Threebot.exe        the launcher (Threebot icon, app window)
├── threebot.ico        icon for the shortcuts it creates
├── app\                the gateway and the built web app
├── runtime\node.exe    Node, against which the gateway runs
└── README.txt          the same steps, for whoever gets the folder
```

Double-click `Threebot.exe`. The first run copies `app\` and `runtime\` into
`%LOCALAPPDATA%\Programs\Threebot`, adds Threebot to the Start Menu and to the
Startup folder, starts the gateway in the background, and opens the app window
only once `http://127.0.0.1:3780/api/health` answers. Later runs reuse that copy.

| What | Where |
| --- | --- |
| App | `%LOCALAPPDATA%\Programs\Threebot` |
| Settings, token, Bots | `%USERPROFILE%\.threebot` |
| Log | `%USERPROFILE%\.threebot\logs\gateway.log` |
| Start Menu | `Threebot` |
| Autostart | Start Menu → Startup → `Threebot` (`--background`) |

## Why not Task Scheduler

Creating a scheduled task needs an elevated token on locked-down machines, and a
portable app must not ask for elevation. The launcher uses the per-user Startup
folder instead, which needs no privileges and does the same job: the gateway
starts when that user signs in.

`threebot up` writes the same pieces when you run it from a checkout: a runner
script (`%USERPROFILE%\.threebot\threebot-serve.cmd`) plus the Startup shortcut.
The gateway records its PID in `%USERPROFILE%\.threebot\gateway.pid`, which is
how restart and upgrade stop the old process.

## Building the bundle

```powershell
# web\dist must exist: npm run build --prefix web
powershell -ExecutionPolicy Bypass -File windows\build-bundle.ps1
```

It produces `dist\windows\Threebot-<version>-win64\` and a `.zip` beside it. The
launcher is Go, so nothing here needs Visual Studio:

```powershell
powershell -ExecutionPolicy Bypass -File windows\launcher\build.ps1
```

`launcher/build.ps1` regenerates `threebot.ico` from `web\public\icon-512.png`
and compiles the icon and the version from `package.json` into a single Windows
resource with `goversioninfo`, so the exe, the Start Menu entry, the taskbar and
Explorer's Details tab all show Threebot's own branding. One resource file is
required: two `.syso` files with `.rsrc` sections cannot be linked into one exe.

## Window

`Threebot.exe` hosts Microsoft Edge's embedded **WebView2** runtime directly in a
native Win32 window owned 100% by `Threebot.exe`. This binds the running window
strictly to Threebot's process identity and taskbar icon:
- **Taskbar Grouping & Identity**: The process calls `SetCurrentProcessExplicitAppUserModelID("Threebot")`
  and sets `PKEY_AppUserModel_ID = "Threebot"`, ensuring the window lights up the pinned Threebot icon,
  shows `threebot.ico`, and provides a jump list context menu titled `Threebot` instead of Microsoft Edge.
- **Single Instance Activation**: Clicking the pinned icon or shortcut when Threebot is already open
  automatically activates and brings the existing Threebot window to the foreground.
- **Isolated Profile**: The browser profile is isolated in `%USERPROFILE%\.threebot\browser`.
- **Fallback**: On systems where the WebView2 runtime is absent, the launcher automatically falls
  back to Chromium / Edge in dedicated standalone app mode with suppression flags (`--disable-fre`)
  and isolated browser profile directory. Without Edge or Chrome the default browser opens the URL.
