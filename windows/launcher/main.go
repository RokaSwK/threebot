// Threebot for Windows: one double-click, no installer, no admin prompt.
//
// The first run copies the bundled app into %LOCALAPPDATA%\Programs\Threebot, sets up the
// per-user autostart shortcut, starts the gateway in the background and opens the app window.
// Every later run reuses that copy and just makes sure the gateway answers before the window
// appears, so nobody ever sees a refused connection.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	appName     = "Threebot"
	windowTitle = "Threebot"
	port        = "3780"
)

var appURL = "http://127.0.0.1:" + port + "/"

func main() {
	background := flag.Bool("background", false, "start the gateway at logon without opening a window")
	flag.Parse()

	if err := run(*background); err != nil {
		fail(err)
	}
}

func run(background bool) error {
	root, err := exeDir()
	if err != nil {
		return err
	}
	installDir := filepath.Join(localAppData(), "Programs", "Threebot")
	home := threebotHome()

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
		return errors.New("the gateway didn't answer on " + appURL + "\n\nLog: " + filepath.Join(home, "logs", "gateway.log"))
	}
	return openWindow(installDir)
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
	if readVersion(installedApp) != readVersion(payloadApp) {
		stopGateway(home) // the running gateway holds the files we are about to replace
		if err := os.MkdirAll(installDir, 0o755); err != nil {
			return "", "", err
		}
		if err := replaceTree(payloadApp, installedApp); err != nil {
			return "", "", err
		}
		if _, statErr := os.Stat(payloadNode); statErr == nil {
			if err := replaceTree(payloadNode, installedNode); err != nil {
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

func readVersion(appDir string) string {
	data, err := os.ReadFile(filepath.Join(appDir, "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func replaceTree(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return copyTree(src, dst)
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

func copyFile(src, dst string) error {
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
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ---------- settings and the T3 token ----------

func writeEnv(home string) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	file := filepath.Join(home, ".env")
	token := filepath.Join(home, "t3-token")
	want := map[string]string{
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
	present := map[string]bool{}
	for _, line := range lines {
		if key, _, found := strings.Cut(line, "="); found {
			present[strings.TrimSpace(key)] = true
		}
	}
	for _, key := range []string{"PORT", "HOST", "T3_URL", "T3_TOKEN_FILE"} {
		if present[key] {
			continue
		}
		lines = append(lines, key+"="+quoteEnv(want[key]))
	}
	return os.WriteFile(file, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
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
	cmd := exec.Command(t3, "auth", "session", "issue", "--ttl", "365d", "--label", "threebot", "--token-only")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	token := strings.TrimSpace(string(out))
	if err != nil || token == "" {
		return
	}
	_ = os.WriteFile(tokenFile, []byte(token+"\n"), 0o600)
}

func findOnPath(names ...string) string {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
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
	cmd.Env = append(os.Environ(), "THREEBOT_HOME="+home)
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
	pid := strings.TrimSpace(string(data))
	if pid == "" {
		return
	}
	cmd := exec.Command("taskkill", "/PID", pid, "/F", "/T")
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

// openWindow shows Threebot as an app window (Chrome or Edge in app mode), so it has its own icon,
// its own taskbar entry and no address bar. The user's normal browser profile is used on purpose:
// a fresh profile makes Edge interrupt the first launch with a sign-in and sync dialog.
func openWindow(installDir string) error {
	args := []string{
		"--app=" + appURL,
		"--window-size=1360,900",
		"--no-first-run",
		"--no-default-browser-check",
	}
	for _, exe := range chromiumCandidates() {
		if !fileExists(exe) {
			continue
		}
		cmd := exec.Command(exe, args...)
		// No HideWindow here: Chromium applies the launcher's STARTUPINFO to its first window.
		if err := cmd.Start(); err == nil {
			// The window outlives this launcher; release it so Threebot.exe can be updated later.
			_ = cmd.Process.Release()
			return nil
		}
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", appURL)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
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
func fail(err error) {
	if !isAttended() {
		return
	}
	showMessageBox(err.Error())
	os.Exit(1)
}

func isAttended() bool {
	// Show a dialog only for an interactive double-click; a logged-on autostart stays silent.
	for _, arg := range os.Args[1:] {
		if arg == "--background" {
			return false
		}
	}
	return true
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
