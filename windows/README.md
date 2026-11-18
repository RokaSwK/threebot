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

The window is Edge or Chrome in app mode (`--app=http://127.0.0.1:3780/`), which
gives a frameless window, its own taskbar entry and Threebot's favicon. It uses
an isolated profile in `%USERPROFILE%\.threebot\browser` to prevent grouping under
Edge's main browser process or inheriting its taskbar icon. First-run dialogs and
sync prompts are suppressed via `--disable-fre` and `--disable-features`. The window
is stamped with Threebot's `AppUserModelID` (`Threebot`) and icon (`threebot.ico`)
via Win32 shell property stores so Windows pins and groups the active window directly
under Threebot's taskbar icon. Without Edge or Chrome the default browser opens the
URL instead.
