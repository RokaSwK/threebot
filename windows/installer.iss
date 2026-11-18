#define MyAppName "Threebot"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.13"
#endif
#define MyAppPublisher "Threebot Authors"
#define MyAppURL "https://github.com/RokaSwK/threebot"
#define MyAppExeName "Threebot.exe"
#ifndef MySourceDir
  #define MySourceDir "..\dist\windows\Threebot-" + MyAppVersion + "-win64"
#endif

[Setup]
AppId={{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\{#MyAppName}
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
Name: "startupicon"; Description: "Start Threebot automatically on sign-in"; GroupDescription: "Startup:"; Flags: checkedonce

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\threebot.ico"; AppUserModelID: "{#MyAppName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\threebot.ico"; AppUserModelID: "{#MyAppName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; IconFilename: "{app}\threebot.ico"; AppUserModelID: "{#MyAppName}"; Tasks: startupicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\Programs\{#MyAppName}\app"
