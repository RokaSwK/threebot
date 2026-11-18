; The one-click installer: Threebot-Setup-<version>.exe, built by windows\build-installer.ps1.
; It installs the portable bundle per user into %LOCALAPPDATA%\Programs\Threebot, the same folder
; Threebot.exe installs itself into, so the installer and the portable bundle upgrade each other.
#define MyAppName "Threebot"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppPublisher "Threebot Authors"
#define MyAppURL "https://github.com/RokaSwK/threebot"
#define MyAppExeName "Threebot.exe"
#ifndef MySourceDir
  #define MySourceDir "..\dist\windows\Threebot-" + MyAppVersion + "-win64"
#endif

[Setup]
; Threebot's own id: it identifies the install for upgrades and Apps & Features, so never change it.
AppId={{AC75C8E7-0AD0-422E-99B0-FC6BB27A1A5B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=Threebot-Setup-{#MyAppVersion}
SetupIconFile={#MySourceDir}\threebot.ico
UninstallDisplayIcon={app}\threebot.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Replace the app and Node instead of overlaying them: a file the new version dropped (a stale
; package left in server\node_modules) must not linger and shadow its replacement.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Threebot.exe rewrites the Start Menu and Startup shortcuts on every run, so they are always made.
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\threebot.ico"; AppUserModelID: "{#MyAppName}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; WorkingDir: "{app}"; IconFilename: "{app}\threebot.ico"; Comment: "{#MyAppName} gateway"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\threebot.ico"; AppUserModelID: "{#MyAppName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
; A silent upgrade stopped the gateway: start it again without opening a window.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Flags: nowait; Check: WizardSilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"
Type: files; Name: "{app}\Threebot.exe"
Type: files; Name: "{app}\threebot.ico"
; Threebot.exe writes these itself too, so the uninstaller may not have a record of them.
Type: files; Name: "{userprograms}\{#MyAppName}.lnk"
Type: files; Name: "{userstartup}\{#MyAppName}.lnk"

[Code]
function ThreebotHome(): String;
begin
  Result := GetEnv('THREEBOT_HOME');
  if Result = '' then
    Result := ExpandConstant('{%USERPROFILE}\.threebot');
end;

// The gateway runs node.exe from {app}\runtime and holds the app's files: stop it the way
// Threebot.exe does (its pid file), so an upgrade replaces them and the new version starts. The
// image filter keeps a stale pid that Windows gave to another program from killing that program.
procedure StopGateway();
var
  PidFile: String;
  Pid: AnsiString;
  ResultCode: Integer;
begin
  PidFile := ThreebotHome() + '\gateway.pid';
  if not LoadStringFromFile(PidFile, Pid) then
    Exit;
  if StrToIntDef(Trim(String(Pid)), 0) > 0 then
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /FI "PID eq ' + Trim(String(Pid)) + '" /FI "IMAGENAME eq node.exe"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  DeleteFile(PidFile);
  Sleep(700);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopGateway();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopGateway();
end;
