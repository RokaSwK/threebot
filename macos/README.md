# Threebot for Mac

A small AppKit app that opens the existing Threebot website in WKWebView.
It uses the same gateway, bot data and frontend. The native window can resize,
minimize and zoom. Website data and window bounds persist between launches.

## Build and run

Requirements: macOS 14 or later and Xcode Command Line Tools with Swift 5.9 or
later. Keep the existing Threebot gateway and T3 Code running. The app opens
`http://127.0.0.1:3780/`; it does not start or stop either service.

From the repository root:

```sh
./script/build_and_run.sh
./script/build_and_run.sh --build-only
./script/build_and_run.sh --verify
```

The script builds `macos/dist/Threebot.app`, adds the existing Threebot icon,
and signs it locally. The build targets the current Mac architecture. This is
a local build, not a notarized release. Copy the app to your Applications folder
to use it outside the checkout.

The Run action uses the same script. Cmd-R reloads, Cmd-plus and Cmd-minus zoom,
and Cmd-0 restores actual size. File inputs open a Mac chooser, and downloads ask
where to save. External links open in the default browser.

## Verification on 2026-11-10

Release build, bundle metadata and strict signature verification passed on
Apple silicon, macOS 15.7.3. The real app opened the existing site, resized from
desktop to compact layout and back, reloaded and retained the selected bot after
quitting and relaunching. Upload selection opened and cancelled. A normal file
download saved with a matching SHA-256 hash; Save cancellation left the app open.

The two related web layout fixes passed 41 existing tests and the frontend
typecheck and build. Live checks covered the Backup model row at 360, 640, 760,
900 and 1200 CSS pixels. Turn off stayed on one line, inside its row, with no
page-wide horizontal overflow. All five Library filters fit within a 320px
details panel by wrapping Files to a second row. Files was also visible and
selectable in the real compact native window.

Not yet verified: live OAuth sign-in, blob URL downloads, native push, voice and
screen-sharing parity. WKWebView is not a guarantee of Safari/PWA API parity.

The implementation follows `docs/designs/mac-app.md`. It reuses no Grok or
OpenBot code or assets.
