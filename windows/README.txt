Threebot for Windows
====================

Nothing to install. Double-click Threebot.exe.

The first run sets Threebot up for this Windows account:

  * copies the app to %LOCALAPPDATA%\Programs\Threebot
  * starts the gateway in the background (it keeps running, and starts again at logon)
  * adds Threebot to the Start Menu
  * opens the app in its own window

Later runs open instantly; the gateway is already there.

Requirements
------------

  Windows 10 or 11 (64-bit). Node.js is included in runtime\node.exe, so nothing
  else has to be installed.

  Threebot talks to T3 Code: keep it running (the T3 Code app, or `t3 up`).
  The first run asks `t3` for a token and saves it for a year. If T3 Code is not
  installed yet, Threebot still opens and tells you what is missing.

Where things live
-----------------

  App          %LOCALAPPDATA%\Programs\Threebot
  Settings     %USERPROFILE%\.threebot  (.env, token, password, bots)
  Logs         %USERPROFILE%\.threebot\logs\gateway.log
  Start Menu   Threebot
  Autostart    Start Menu > Startup > Threebot

Commands (optional, run in this folder with the bundled Node)
--------------------------------------------------------------

  runtime\node.exe app\server\cli.mjs status
  runtime\node.exe app\server\cli.mjs service restart
  runtime\node.exe app\server\cli.mjs --help

Uninstall
---------

  Delete %LOCALAPPDATA%\Programs\Threebot, the Threebot shortcuts in the Start
  Menu (including Startup), and %USERPROFILE%\.threebot if you also want your
  settings and bots gone. The gateway keeps running until you sign out or end
  node.exe.
