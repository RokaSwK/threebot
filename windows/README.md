# Threebot for Windows

Threebot runs as a background service on Windows (Task Scheduler) and is reached
in the browser at http://127.0.0.1:3780. The web app is an installable PWA, so
you can install it from Edge/Chrome for an app-like window without a native
wrapper.

## Quick app window (no build needed)

`launch-app.ps1` opens Threebot in Microsoft Edge's app mode, which gives a
standalone window with its own taskbar entry:

```powershell
powershell -File windows\launch-app.ps1
```

## Optional native shell

`src/main.rs` is a minimal WebView2 shell built with Rust + `wry`. It needs the
MSVC Rust toolchain and the Visual Studio C++ build tools (link.exe) installed.
Build with:

```powershell
rustup default stable-x86_64-pc-windows-msvc
cd windows
cargo build --release
```

The resulting `target\release\Threebot.exe` opens the gateway URL (override with
the `THREEBOT_URL` environment variable). This is optional; the PWA or Edge app
mode is the recommended experience.
