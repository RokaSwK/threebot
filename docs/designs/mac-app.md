# Mac app: the existing Threebot UI in a native window

Status: Reviewed v2, three focused reviews completed; findings applied
Date: 2026-11-10

## Goal

Open the current Threebot website in a normal, resizable Mac application.
Keep the same frontend, layout, features, data and gateway.
The first useful version is a local `.app`, with no frontend rewrite.

Two user-reported layout bugs are included:

- The Library filter row clips the Files button in a narrow panel.
- The Backup model control squeezes Turn off onto two lines beside a long model.

## Evidence and choice

Threebot already serves React, Vite and Tailwind from `web/dist` through its
Node gateway. `docs/architecture.md` describes this boundary. The installed
gateway is reachable at `http://127.0.0.1:3780/` on this Mac.

Safari Add to Dock is the quickest no-code option. A maintained Mac-only
wrapper can be a small AppKit application with one WKWebView. It uses the
system WebKit instead of shipping Chromium. Tauri adds Rust and a framework;
Electron adds Chromium and Node. Neither is needed for this first Mac-only
window. This is a scope judgment, not a measured performance comparison.

Apple references: https://developer.apple.com/documentation/webkit/wkwebview
and https://support.apple.com/en-us/104996.

## Non-goals

- No redesign, new navigation, native rewrite or new agent runtime.
- No bundling or restarting T3, the gateway or the bot desktop container.
- No cross-platform packaging, updater, App Store release or notarization.
- No claim that WKWebView matches all Safari/PWA APIs, including Web Push
  (delivery after the app quits) and voice.

## Architecture and files

Use `macos/Package.swift`, targeting macOS 14, with a single executable product
named `ThreebotMac`. `macos/Sources/ThreebotMac/main.swift` owns NSApplication,
one NSWindow and its WKWebView. AppKit is sufficient; do not add a SwiftUI layer
or third-party dependencies.

`script/build_and_run.sh` builds the package and stages
`macos/dist/Threebot.app`. Launch the bundle through `open`, not its raw binary.
Support `--build-only` and `--verify`; normal use builds and opens the app.
Only stop this app's own process when rebuilding, never any Threebot gateway.
Give the bundle the identifier `tools.swk.threebot` and an ad-hoc signature. Use the existing Threebot icon. Ignore `macos/.build/` and
`macos/dist/`.


### Window and website contract

- Default content size 1200 by 800, minimum 360 by 480.
- Use standard close, minimize, maximize and fullscreen controls.
- Save and restore window geometry. Closing and reopening from the Dock opens
  the same single window. Quitting the app does not stop the gateway or agents.
- The webview fills the window's content area and uses its persistent default
  website data store. No injected layout CSS or JavaScript in production.
- Load the gateway at `HOST` and `PORT` from `$THREEBOT_HOME/.env` (default
  `~/.threebot/.env`), else `http://127.0.0.1:3780/`. A wildcard or loopback
  `HOST` is reached on 127.0.0.1. Keep its origin and routes.
  All gateway cookies, HTTP APIs and WebSockets use the same site.
- Provide standard Edit menu shortcuts, Reload, Zoom In, Zoom Out, Actual Size,
  and a native Window menu. Zoom is optional display scaling, not a redesign.
- Keep same-origin navigation inside the webview. Open user-activated external
  http/https and mailto links in the default browser. Handle target=_blank
  same-origin links and blob downloads without losing the main app window.
  Block unexpected external navigation and unknown executable URL schemes.
  The only JavaScript-to-native bridge is for notifications (below).
- Preserve the existing Connect Apps flow: it creates an about:blank popup in a
  click, then sets its URL after an API call. Retain a temporary child webview
  long enough to hand its first external HTTP(S) URL to the default browser.
  Connect Apps clears opener and polls connection state, so it does not need a
  cross-browser postMessage bridge. Dispose of temporary children afterwards.
- Permit browser handoff for redirects within a user-started top-level
  navigation, including `/api/thread-link`. Do not silently break existing
  links merely because a redirect is reported as navigation type other.
- Support file inputs with NSOpenPanel and downloads with WKDownload and a
  user-selected NSSavePanel destination. Do not silently write user files.
- On a top-level load failure, show a native Retry message that says the local
  Threebot service must be running. Avoid repeated modal alerts on cancellation.
- Request only local networking ATS support. Do not disable web security or
  add broad ATS exceptions.

### Notifications

Measured in WKWebView on macOS 15: `Notification.requestPermission()` resolves
`denied`, the service worker's `showNotification` throws for lack of
permission, and `PushManager` is absent. A document-start script in the main
frame replaces `Notification` and `ServiceWorkerRegistration.showNotification`
and posts show, close and permission requests to one message handler. The
handler accepts messages only from the main frame at the gateway origin and
uses UserNotifications. A notification's tag replaces the earlier one with the
same tag. A click brings the window forward and runs the page's `onclick`, or
opens the notification's same-origin URL as the service worker would.
Permission is re-read when the app becomes active. `enablePushNotifications`
treats granted permission as enabled when the Push API is missing.

Verified on macOS 15.7 with an ad-hoc signed bundle opened from Finder: macOS
asked for permission, then showed both the page and service worker
notifications, and a real Bot's "Waiting for you" and completion text. When the
first request came from a process the user did not open, macOS recorded the app
as denied without asking ("Notifications are not allowed for this
application"); turning it on in System Settings › Notifications fixed it.

### Existing frontend bug fixes

In `web/src/components/SettingsDialog.tsx`, give the Backup model actions a
named class. In the existing stylesheet, make this flex child bounded and
shrinkable, keep Turn off on one line, and let its model picker shrink with
ellipsis. At narrow widths it may wrap below the description, retaining the
same controls and text. Do not change the selected model or fallback behavior.

In `web/src/components/Library.tsx`, give the Library filter row a named class.
Use wrapping with the existing pill styles so every filter, including Files,
is visible and reachable in narrow side panels and mobile widths. Preserve
filter order, selected state, labels and filtering behavior. One additional
row at narrow widths is an intended bug fix, not a new design.


## Verification and acceptance

1. Run the existing frontend typecheck and relevant existing tests, then build
   `web/dist`. Do not invent checks that the repo does not provide.
2. Build the native app and verify its bundle metadata, signature and launch.
3. Inspect the real native window. Check the existing site loads, resize down
   to compact width and back, and confirm the webview follows the content area.
4. Check Backup model with a long model name and Library with all five filters
   at 360, 640, 760, 900 and 1200 CSS pixels where practical. Check the narrow
   details panel, not only the full viewport. Use an isolated local fixture for
   long model names if the user's current live fallback does not cover it;
   do not change their fallback settings to create test data. No page-wide horizontal overflow;
   Files is fully visible, and Turn off is one line and clickable.
5. Exercise reload, a harmless text edit shortcut, window close/reopen, and
   relaunch. Check retained website state without sending a model message or
   changing user settings. Check an upload chooser can open and cancel. Verify
   normal and blob downloads, Save cancellation and that the main window stays
   open. If an action cannot be verified, name it as an untested feature.
6. Separate compiled/static, live WebKit and untested features in the report.
   No claim of full app parity, notification support or measured memory savings
   without corresponding runtime evidence.
