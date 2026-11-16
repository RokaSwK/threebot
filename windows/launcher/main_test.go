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
