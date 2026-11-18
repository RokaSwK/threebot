package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteEnvRewritesManagedKeys(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".env"), []byte("PORT=9999\nCUSTOM=keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeEnv(home); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "PORT=3780") {
		t.Fatalf("managed PORT was not rewritten: %q", text)
	}
	if strings.Contains(text, "PORT=9999") {
		t.Fatalf("stale PORT survived: %q", text)
	}
	if !strings.Contains(text, "CUSTOM=keep") {
		t.Fatalf("unrelated key was lost: %q", text)
	}
	if !strings.Contains(text, "T3_TOKEN_FILE=") {
		t.Fatalf("token path is missing: %q", text)
	}
}

func TestCleanGatewayEnv(t *testing.T) {
	for key, value := range map[string]string{
		"PORT": "1", "HOST": "x", "T3_URL": "x", "T3_TOKEN_FILE": "x",
		"THREEBOT_HOME": "x", "KEEP_ME": "yes",
	} {
		t.Setenv(key, value)
	}
	for _, entry := range cleanGatewayEnv() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "PORT", "HOST", "T3_URL", "T3_TOKEN_FILE", "THREEBOT_HOME":
			t.Fatalf("managed variable %s leaked into the gateway environment", key)
		}
	}
	found := false
	for _, entry := range cleanGatewayEnv() {
		if strings.HasPrefix(entry, "KEEP_ME=") {
			found = true
		}
	}
	if !found {
		t.Fatal("unrelated environment variable was dropped")
	}
}

func TestStopGatewayIgnoresMalformedPid(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "gateway.pid")
	if err := os.WriteFile(file, []byte("not-a-pid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stopGateway(home)
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("malformed pid file should be discarded, got %v", err)
	}
}

func TestReplaceTreeSwapsContents(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "app")
	if err := os.WriteFile(filepath.Join(src, "VERSION"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "old"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := replaceTree(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "VERSION")); err != nil {
		t.Fatalf("new content is missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "old")); !os.IsNotExist(err) {
		t.Fatalf("old content survived the swap: %v", err)
	}
	if _, err := os.Stat(dst + ".old"); !os.IsNotExist(err) {
		t.Fatalf("rollback copy should be cleaned up: %v", err)
	}
}

func TestPrepareInstallsBundledNodeAsFile(t *testing.T) {
	root, installed, home := t.TempDir(), t.TempDir(), t.TempDir()
	for name, content := range map[string]string{"app/server/cli.mjs": "// fixture", "app/VERSION": "1.2.3", "runtime/node.exe": "bundled node"} {
		file := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil { t.Fatal(err) }
		if err := os.WriteFile(file, []byte(content), 0644); err != nil { t.Fatal(err) }
	}
	_, node, err := prepare(root, installed, home)
	if err != nil { t.Fatal(err) }
	data, err := os.ReadFile(node)
	if err != nil { t.Fatal(err) }
	if string(data) != "bundled node" { t.Fatalf("wrong Node payload: %q", data) }
}

func TestEnsureTokenRunsCmdShimWithSpaces(t *testing.T) {
	home, bin := t.TempDir(), filepath.Join(t.TempDir(), "T3 Code bin")
	if err := os.MkdirAll(bin, 0755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(bin, "t3.cmd"), []byte("@echo off\r\necho fixture-token\r\n"), 0644); err != nil { t.Fatal(err) }
	t.Setenv("PATH", bin)
	ensureToken(home)
	data, err := os.ReadFile(filepath.Join(home, "t3-token"))
	if err != nil { t.Fatal(err) }
	if strings.TrimSpace(string(data)) != "fixture-token" { t.Fatalf("wrong token: %q", data) }
}

func TestWindowArgsUsesIsolatedProfileAndAppId(t *testing.T) {
	home := t.TempDir()
	args := windowArgs(home)
	expectedProfile := "--user-data-dir=" + filepath.Join(home, "browser")
	foundProfile, foundAppId, foundClass, foundFre := false, false, false, false
	for _, arg := range args {
		if arg == expectedProfile {
			foundProfile = true
		}
		if arg == "--app-id=threebot-desktop" {
			foundAppId = true
		}
		if arg == "--class=Threebot" {
			foundClass = true
		}
		if arg == "--disable-fre" {
			foundFre = true
		}
	}
	if !foundProfile {
		t.Fatalf("expected profile flag %q in args: %v", expectedProfile, args)
	}
	if !foundAppId {
		t.Fatalf("expected --app-id=threebot-desktop in args: %v", args)
	}
	if !foundClass {
		t.Fatalf("expected --class=Threebot in args: %v", args)
	}
	if !foundFre {
		t.Fatalf("expected --disable-fre in args: %v", args)
	}
}
