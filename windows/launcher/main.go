// Threebot for Windows: one double-click, no installer, no admin prompt.
//
// The first run copies the bundled app into %LOCALAPPDATA%\Programs\Threebot, sets up the
// per-user autostart shortcut, starts the gateway in the background and opens the app window.
// Every later run reuses that copy and just makes sure the gateway answers before the window
// appears, so nobody ever sees a refused connection.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

const (
	appName     = "Threebot"
	windowTitle = "Threebot"
	port        = "3780"
)

var appURL = "http://127.0.0.1:" + port + "/"

// version is injected at build time by windows/launcher/build.ps1 via -X main.version.
var version = "dev"

func main() {
	background := flag.Bool("background", false, "start the gateway at logon without opening a window")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	if err := run(*background); err != nil {
		fail(err, *background)
	}
}

func run(background bool) error {
	root, err := exeDir()
	if err != nil {
		return err
	}
	installDir := filepath.Join(localAppData(), "Programs", "Threebot")
	home := threebotHome()

	if !background {
		if bundleUpgrades(root, installDir) {
			// A newer bundle replaces the installed copy, including the Threebot.exe an open window
			// is running from: close that window first instead of just focusing it.
			closeExistingWindow(5 * time.Second)
		} else if activateExistingWindow() {
			return nil
		}
	}

	appDir, nodeExe, err := prepare(root, installDir, home)
	if err != nil {
		return err
	}
	if err := writeEnv(home); err != nil {
		return err
	}
	ensureToken(home) // best effort: without T3 Code the app still opens and says what is missing
	installShortcuts(installDir, root)

	healthy := healthyFor(1500 * time.Millisecond)
	if !healthy {
		if err := startGateway(appDir, nodeExe, home); err != nil {
			return err
		}
		healthy = waitHealthy(45 * time.Second)
	}
	if background {
		return nil
	}
	if !healthy {
		logPath := filepath.Join(home, "logs", "gateway.log")
		return fmt.Errorf("the gateway didn't answer on %s\n\n%s", appURL, diagnostic(logPath))
	}
	return openWindow(installDir, home)
}

// ---------- where things live ----------

func exeDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

func localAppData() string {
	if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
		return dir
	}
	return filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
}

func roamingAppData() string {
	if dir := os.Getenv("APPDATA"); dir != "" {
		return dir
	}
	return filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
}

func threebotHome() string {
	if dir := os.Getenv("THREEBOT_HOME"); dir != "" {
		return dir
	}
	return filepath.Join(os.Getenv("USERPROFILE"), ".threebot")
}

// ---------- the app copy ----------

// prepare makes sure the installed copy is the one this exe carries, and says where to run it from.
func prepare(root, installDir, home string) (appDir, nodeExe string, err error) {
	payloadApp, payloadNode := filepath.Join(root, "app"), filepath.Join(root, "runtime")
	if _, statErr := os.Stat(filepath.Join(payloadApp, "server", "cli.mjs")); statErr != nil {
		// Running from the installed copy already: nothing to copy.
		return filepath.Join(root, "app"), filepath.Join(root, "runtime", "node.exe"), nil
	}

	installedApp := filepath.Join(installDir, "app")
	installedNode := filepath.Join(installDir, "runtime", "node.exe")
	// An installed copy without VERSION is incomplete, so treat it as needing a fresh install.
	if installedVersion := readVersion(installedApp); installedVersion == "" || installedVersion != readVersion(payloadApp) {
		stopGateway(home) // the running gateway holds the files we are about to replace
		if err := os.MkdirAll(installDir, 0o755); err != nil {
			return "", "", err
		}
		if err := replaceTree(payloadApp, installedApp); err != nil {
			return "", "", err
		}
		if _, statErr := os.Stat(payloadNode); statErr == nil {
			if err := replaceTree(payloadNode, filepath.Dir(installedNode)); err != nil {
				return "", "", err
			}
		}
	}
	// Keep Threebot.exe beside its app, so updates leave one shortcut to fix, not two.
	self, _ := os.Executable()
	if self != "" {
		_ = copyFile(self, filepath.Join(installDir, "Threebot.exe"))
	}
	return installedApp, installedNode, nil
}

// bundleUpgrades reports whether this exe carries an app that differs from the installed one.
func bundleUpgrades(root, installDir string) bool {
	payloadApp := filepath.Join(root, "app")
	if !fileExists(filepath.Join(payloadApp, "server", "cli.mjs")) {
		return false // running from the installed copy
	}
	installed := readVersion(filepath.Join(installDir, "app"))
	return installed == "" || installed != readVersion(payloadApp)
}

func readVersion(appDir string) string {
	data, err := os.ReadFile(filepath.Join(appDir, "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// replaceTree stages a complete copy next to dst, then swaps it in. A failed copy leaves the old
// install usable instead of deleting it first; the previous tree is only dropped after the swap.
func replaceTree(src, dst string) error {
	parent := filepath.Dir(dst)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".threebot-staging-")
	if err != nil {
		return err
	}
	installed := false
	defer func() {
		if !installed {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := copyTree(src, staging); err != nil {
		return err
	}

	backup := dst + ".old"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(staging, dst); err != nil {
		if _, statErr := os.Stat(backup); statErr == nil {
			_ = os.Rename(backup, dst)
		}
		return err
	}
	installed = true
	_ = os.RemoveAll(backup)
	return nil
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) (err error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(dst) // never leave a truncated file that looks installed
		}
	}()
	_, err = io.Copy(out, in)
	return err
}

// ---------- settings and the T3 token ----------

func writeEnv(home string) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	file := filepath.Join(home, ".env")
	token := filepath.Join(home, "t3-token")
	managed := map[string]string{
		"PORT":          port,
		"HOST":          "127.0.0.1",
		"T3_URL":        "http://127.0.0.1:3773",
		"T3_TOKEN_FILE": token,
	}
	existing, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(existing), "\r\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	// These keys must match the launcher's hardcoded health check. Rewrite them on every run so a
	// stale PORT from an older install cannot leave the gateway listening somewhere else forever.
	kept := lines[:0]
	for _, line := range lines {
		key, _, found := strings.Cut(line, "=")
		if found {
			if _, isManaged := managed[strings.TrimSpace(strings.TrimSuffix(key, "\r"))]; isManaged {
				continue
			}
		}
		kept = append(kept, line)
	}
	for _, key := range []string{"PORT", "HOST", "T3_URL", "T3_TOKEN_FILE"} {
		kept = append(kept, key+"="+quoteEnv(managed[key]))
	}
	return os.WriteFile(file, []byte(strings.Join(kept, "\n")+"\n"), 0o600)
}

// quoteEnv keeps a path with spaces readable by the CLI's .env parser.
func quoteEnv(value string) string {
	if strings.ContainsAny(value, " #\"'") {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return value
}

func ensureToken(home string) {
	tokenFile := filepath.Join(home, "t3-token")
	if _, err := os.Stat(tokenFile); err == nil {
		return
	}
	t3 := findOnPath("t3.cmd", "t3.exe")
	if t3 == "" {
		if home := os.Getenv("USERPROFILE"); home != "" {
			candidate := filepath.Join(home, ".t3", "bin", "t3.cmd")
			if _, err := os.Stat(candidate); err == nil {
				t3 = candidate
			}
		}
	}
	if t3 == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, t3, "auth", "session", "issue", "--ttl", "365d", "--label", "threebot", "--token-only")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if strings.EqualFold(filepath.Ext(t3), ".cmd") || strings.EqualFold(filepath.Ext(t3), ".bat") {
		shell := os.Getenv("ComSpec")
		if shell == "" {
			shell = "cmd.exe"
		}
		cmd = exec.CommandContext(ctx, shell)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CmdLine: `cmd.exe /d /s /c ""` + t3 + `" auth session issue --ttl 365d --label threebot --token-only"`}
	}
	out, err := cmd.Output()
	token := strings.TrimSpace(string(out))
	if err != nil || token == "" || ctx.Err() != nil {
		return
	}
	_ = os.WriteFile(tokenFile, []byte(token+"\n"), 0o600)
}

func findOnPath(names ...string) string {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" { // an empty PATH entry is the current directory, not a safe search target
			continue
		}
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

// ---------- shortcuts ----------

// installShortcuts puts Threebot in the Start Menu and makes it survive a reboot, both per user.
func installShortcuts(installDir, root string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	if packed := filepath.Join(installDir, "Threebot.exe"); fileExists(packed) {
		self = packed
	}
	icon := filepath.Join(installDir, "threebot.ico")
	if !fileExists(icon) {
		if bundled := filepath.Join(root, "threebot.ico"); fileExists(bundled) {
			_ = copyFile(bundled, icon)
		} else {
			icon = self
		}
	}
	writeShortcut(filepath.Join(roamingAppData(), "Microsoft", "Windows", "Start Menu", "Programs", "Threebot.lnk"),
		self, "", installDir, icon, appName)
	writeShortcut(filepath.Join(roamingAppData(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Threebot.lnk"),
		self, "--background", installDir, icon, appName+" gateway")
}

func writeShortcut(lnk, target, args, workdir, icon, description string) {
	script := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut(%s)
$s.TargetPath = %s
$s.Arguments = %s
$s.WorkingDirectory = %s
$s.IconLocation = %s
$s.Description = %s
$s.Save()
`, psQuote(lnk), psQuote(target), psQuote(args), psQuote(workdir), psQuote(icon), psQuote(description))

	file := filepath.Join(os.TempDir(), fmt.Sprintf("threebot-shortcut-%d.ps1", time.Now().UnixNano()))
	if err := os.WriteFile(file, []byte(script), 0o600); err != nil {
		return
	}
	defer os.Remove(file)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}

func psQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

// ---------- the gateway ----------

// cleanGatewayEnv removes inherited variables that cli.mts would otherwise prefer over the
// managed .env (it only fills keys that are undefined). The launcher health-checks a fixed port,
// so a parent shell's PORT or HOST must not move the gateway somewhere else.
func cleanGatewayEnv() []string {
	managed := map[string]bool{
		"PORT": true, "HOST": true, "T3_URL": true, "T3_TOKEN_FILE": true, "THREEBOT_HOME": true,
	}
	var out []string
	for _, entry := range os.Environ() {
		key, _, found := strings.Cut(entry, "=")
		if found && managed[key] {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func startGateway(appDir, nodeExe, home string) error {
	if !fileExists(nodeExe) {
		if found := findOnPath("node.exe"); found != "" {
			nodeExe = found
		} else {
			return errors.New("Threebot needs its bundled Node runtime; runtime\\node.exe is missing.\n\nRe-download the Threebot bundle.")
		}
	}
	if err := os.MkdirAll(filepath.Join(home, "logs"), 0o755); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(home, "logs", "gateway.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.Command(nodeExe, filepath.Join(appDir, "server", "cli.mjs"), "serve")
	cmd.Dir = appDir
	cmd.Env = append(cleanGatewayEnv(), "THREEBOT_HOME="+home, "THREEBOT_SERVICE=1")
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008} // DETACHED_PROCESS
	if err := cmd.Start(); err != nil {
		log.Close()
		return err
	}
	go func() { _ = cmd.Wait(); log.Close() }()
	return nil
}

func stopGateway(home string) {
	data, err := os.ReadFile(filepath.Join(home, "gateway.pid"))
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		// A stale or malformed pid file must never turn into a taskkill on an unrelated process.
		_ = os.Remove(filepath.Join(home, "gateway.pid"))
		return
	}
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F", "/T")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
	_ = os.Remove(filepath.Join(home, "gateway.pid"))
	time.Sleep(700 * time.Millisecond)
}

func healthyFor(timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	res, err := client.Get(appURL + "api/health")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusOK
}

func waitHealthy(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if healthyFor(1500 * time.Millisecond) {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// ---------- the window ----------

var (
	user32                                      = syscall.NewLazyDLL("user32.dll")
	shell32                                     = syscall.NewLazyDLL("shell32.dll")
	procEnumWindows                             = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID                = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible                         = user32.NewProc("IsWindowVisible")
	procSetWindowTextW                          = user32.NewProc("SetWindowTextW")
	procSendMessageW                            = user32.NewProc("SendMessageW")
	procPostMessageW                            = user32.NewProc("PostMessageW")
	procLoadImageW                              = user32.NewProc("LoadImageW")
	procFindWindowW                             = user32.NewProc("FindWindowW")
	procDestroyWindow                           = user32.NewProc("DestroyWindow")
	procSetForegroundWindow                     = user32.NewProc("SetForegroundWindow")
	procShowWindow                              = user32.NewProc("ShowWindow")
	procSHGetPropertyStoreForWindow             = shell32.NewProc("SHGetPropertyStoreForWindow")
	procSetCurrentProcessExplicitAppUserModelID = shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
)

// webviewWindowClass is the Win32 class go-webview2 registers for its window. Matching on class and
// title together keeps an Explorer window of a folder named "Threebot" from passing as the app.
const webviewWindowClass = "webview"

type propertyKey struct {
	fmtid syscall.GUID
	pid   uint32
}

// propVariant mirrors PROPVARIANT for a VT_LPWSTR value (24 bytes on 64-bit Windows).
type propVariant struct {
	vt        uint16
	reserved1 uint16
	reserved2 uint16
	reserved3 uint16
	pwszVal   *uint16
	padding   [8]byte
}

type iPropertyStoreVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	GetCount       uintptr
	GetAt          uintptr
	GetValue       uintptr
	SetValue       uintptr
	Commit         uintptr
}

type iPropertyStore struct {
	lpVtbl *iPropertyStoreVtbl
}

// setAppUserModelID stamps PKEY_AppUserModel_ID on a window, so the taskbar groups it under the
// pinned Threebot shortcut instead of under the browser that drew it.
func setAppUserModelID(hwnd uintptr, appID string) error {
	iid := syscall.GUID{ // IID_IPropertyStore
		Data1: 0x886D8EEB, Data2: 0x8CF2, Data3: 0x4446,
		Data4: [8]byte{0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99},
	}
	var store *iPropertyStore
	r1, _, _ := procSHGetPropertyStoreForWindow.Call(hwnd, uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&store)))
	if r1 != 0 || store == nil {
		return fmt.Errorf("SHGetPropertyStoreForWindow failed: hr=0x%x", r1)
	}
	defer syscall.SyscallN(store.lpVtbl.Release, uintptr(unsafe.Pointer(store)))

	pkey := propertyKey{
		fmtid: syscall.GUID{
			Data1: 0x9F4C2855, Data2: 0x9F79, Data3: 0x4B39,
			Data4: [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3},
		},
		pid: 5, // PKEY_AppUserModel_ID
	}
	ptr, err := syscall.UTF16PtrFromString(appID)
	if err != nil {
		return err
	}
	pv := propVariant{vt: 31 /* VT_LPWSTR */, pwszVal: ptr}
	if hr, _, _ := syscall.SyscallN(store.lpVtbl.SetValue, uintptr(unsafe.Pointer(store)), uintptr(unsafe.Pointer(&pkey)), uintptr(unsafe.Pointer(&pv))); hr != 0 {
		return fmt.Errorf("IPropertyStore.SetValue failed: hr=0x%x", hr)
	}
	if hr, _, _ := syscall.SyscallN(store.lpVtbl.Commit, uintptr(unsafe.Pointer(store))); hr != 0 {
		return fmt.Errorf("IPropertyStore.Commit failed: hr=0x%x", hr)
	}
	return nil
}

// iconPath prefers the installed icon and falls back to the one next to this exe.
func iconPath(installDir string) string {
	ico := filepath.Join(installDir, "threebot.ico")
	if !fileExists(ico) {
		if root, err := exeDir(); err == nil {
			ico = filepath.Join(root, "threebot.ico")
		}
	}
	return ico
}

// setWindowIcon gives a window Threebot's big (Alt+Tab, taskbar) and small (title bar) icons.
func setWindowIcon(hwnd uintptr, icoPath string) {
	if !fileExists(icoPath) {
		return
	}
	icoPtr, err := syscall.UTF16PtrFromString(icoPath)
	if err != nil {
		return
	}
	const (
		imageIcon      = 1
		lrLoadFromFile = 0x00000010
		wmSetIcon      = 0x0080
		iconSmall      = 0
		iconBig        = 1
	)
	if hBig, _, _ := procLoadImageW.Call(0, uintptr(unsafe.Pointer(icoPtr)), imageIcon, 32, 32, lrLoadFromFile); hBig != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hBig)
	}
	if hSmall, _, _ := procLoadImageW.Call(0, uintptr(unsafe.Pointer(icoPtr)), imageIcon, 16, 16, lrLoadFromFile); hSmall != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hSmall)
	}
}

// applyWindowBranding waits briefly for the browser's first visible window and gives it Threebot's
// AppUserModelID, title and icon.
func applyWindowBranding(pid int, title, icoPath string) {
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var wndPid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&wndPid)))
		if int(wndPid) == pid {
			if vis, _, _ := procIsWindowVisible.Call(hwnd); vis != 0 {
				found = hwnd
				return 0 // stop enumerating
			}
		}
		return 1
	})
	for deadline := time.Now().Add(6 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		found = 0
		procEnumWindows.Call(cb, 0)
		if found == 0 {
			continue
		}
		_ = setAppUserModelID(found, appName)
		if ptr, err := syscall.UTF16PtrFromString(title); err == nil {
			procSetWindowTextW.Call(found, uintptr(unsafe.Pointer(ptr)))
		}
		setWindowIcon(found, icoPath)
		return
	}
}

// windowArgs builds Chromium flags to run Threebot in standalone app mode with an
// isolated browser profile and first-run prompts disabled.
func windowArgs(home string) []string {
	browserDir := filepath.Join(home, "browser")
	return []string{
		"--app=" + appURL,
		"--user-data-dir=" + browserDir,
		"--class=" + appName,
		"--app-id=threebot-desktop",
		"--window-size=1360,900",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-fre",
		"--disable-features=msFirstRunExperience,msEdgeSyncPrompt,msWelcomePage,msEdgeHubFirstRun",
	}
}

// existingWindow finds an open Threebot WebView2 window, or returns 0.
func existingWindow() uintptr {
	class, err := syscall.UTF16PtrFromString(webviewWindowClass)
	if err != nil {
		return 0
	}
	title, err := syscall.UTF16PtrFromString(windowTitle)
	if err != nil {
		return 0
	}
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return 0
	}
	if vis, _, _ := procIsWindowVisible.Call(hwnd); vis == 0 {
		return 0
	}
	return hwnd
}

// activateExistingWindow brings an open Threebot window to the front, so a second click on the
// pinned icon doesn't start a second copy.
func activateExistingWindow() bool {
	hwnd := existingWindow()
	if hwnd == 0 {
		return false
	}
	const swRestore = 9
	procShowWindow.Call(hwnd, swRestore)
	procSetForegroundWindow.Call(hwnd)
	return true
}

// closeExistingWindow asks an open Threebot window to close and waits for its launcher to exit, so
// an update can replace the Threebot.exe that process is running from.
func closeExistingWindow(timeout time.Duration) {
	hwnd := existingWindow()
	if hwnd == 0 {
		return
	}
	var pid uint32
	procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	const wmClose = 0x0010
	procPostMessageW.Call(hwnd, wmClose, 0, 0)
	if pid == 0 {
		return
	}
	const synchronize = 0x00100000
	handle, err := syscall.OpenProcess(synchronize, false, pid)
	if err != nil {
		return
	}
	defer syscall.CloseHandle(handle)
	_, _ = syscall.WaitForSingleObject(handle, uint32(timeout/time.Millisecond))
}

// webView2Installed reports whether the Evergreen WebView2 runtime (or a matching Edge channel) is
// present. go-webview2 exits the process on a failed environment, so check before trying it.
func webView2Installed() bool {
	installed, err := webviewloader.GetInstalledVersion()
	return err == nil && installed != ""
}

func openWebView2Window(installDir, home string) (err error) {
	if !webView2Installed() {
		return errors.New("the WebView2 runtime isn't installed")
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("webview2 panicked: %v", r)
		}
	}()

	if ptr, err := syscall.UTF16PtrFromString(appName); err == nil {
		procSetCurrentProcessExplicitAppUserModelID.Call(uintptr(unsafe.Pointer(ptr)))
	}

	dataPath := filepath.Join(home, "browser")
	_ = os.MkdirAll(dataPath, 0o755)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataPath,
		WindowOptions: webview2.WindowOptions{
			Title:  windowTitle,
			Width:  1360,
			Height: 900,
			Center: true,
			IconId: 1,
		},
	})
	if w == nil {
		// go-webview2 shows its window before embedding the browser and leaves it behind when that
		// fails; remove it so the fallback window isn't joined by an empty one.
		if hwnd := existingWindow(); hwnd != 0 {
			procDestroyWindow.Call(hwnd)
		}
		return errors.New("failed to initialize webview2")
	}
	defer w.Destroy()

	if hwnd := uintptr(w.Window()); hwnd != 0 {
		_ = setAppUserModelID(hwnd, appName)
		setWindowIcon(hwnd, iconPath(installDir))
	}

	w.Navigate(appURL)
	w.Run()
	return nil
}

func openChromiumWindow(installDir, home string) error {
	args := windowArgs(home)
	icoPath := iconPath(installDir)
	for _, exe := range chromiumCandidates() {
		if !fileExists(exe) {
			continue
		}
		cmd := exec.Command(exe, args...)
		// No HideWindow here: Chromium applies the launcher's STARTUPINFO to its first window.
		if err := cmd.Start(); err == nil {
			// Brand the window with Threebot's AppUserModelID and icon, then release the process: the
			// window outlives this launcher, so Threebot.exe can be updated later.
			applyWindowBranding(cmd.Process.Pid, windowTitle, icoPath)
			_ = cmd.Process.Release()
			return nil
		}
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", appURL)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}

// openWindow displays Threebot. It first attempts to open a native Win32 window hosting
// the embedded WebView2 runtime (Solution B). This gives a native window 100% owned by
// Threebot.exe, keeping the taskbar icon permanently bound to Threebot and displaying
// Threebot's jump list. If WebView2 is unavailable, it falls back to Chromium app mode.
func openWindow(installDir, home string) error {
	if err := openWebView2Window(installDir, home); err == nil {
		return nil
	}
	return openChromiumWindow(installDir, home)
}

func chromiumCandidates() []string {
	var out []string
	for _, key := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if dir := os.Getenv(key); dir != "" {
			out = append(out,
				filepath.Join(dir, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(dir, "Google", "Chrome", "Application", "chrome.exe"),
			)
		}
	}
	return out
}

// ---------- diagnostics ----------

// fail tells the user what broke even when the exe was started from Explorer, which swallows stderr.
// A background autostart stays silent: nobody is there to dismiss a dialog.
func fail(err error, background bool) {
	if background {
		return
	}
	showMessageBox(err.Error())
	os.Exit(1)
}

// diagnostic includes the tail of the gateway log, so a missing token or a bad .env says what
// actually happened instead of only reporting "gateway didn't answer".
func diagnostic(logPath string) string {
	data, err := os.ReadFile(logPath)
	if err != nil || len(data) == 0 {
		return "No gateway log yet: " + logPath
	}
	lines := strings.Split(strings.TrimRight(string(data), "\r\n"), "\n")
	if len(lines) > 12 {
		lines = lines[len(lines)-12:]
	}
	return "Last lines of " + logPath + ":\n" + strings.Join(lines, "\n")
}

func showMessageBox(text string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	title, _ := syscall.UTF16PtrFromString(windowTitle)
	body, _ := syscall.UTF16PtrFromString(text)
	const mbIconError, mbOK = 0x10, 0x0
	messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), mbIconError|mbOK)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
