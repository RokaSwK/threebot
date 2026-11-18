package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeApp(t *testing.T, dir, version string) {
	t.Helper()
	for name, content := range map[string]string{"server/cli.mjs": "// fixture", "VERSION": version} {
		file := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBundleUpgrades(t *testing.T) {
	root, installDir := t.TempDir(), t.TempDir()
	if bundleUpgrades(root, installDir) {
		t.Fatal("an exe without a payload (the installed copy) is not an upgrade")
	}
	writeApp(t, filepath.Join(root, "app"), "1.2.3")
	if !bundleUpgrades(root, installDir) {
		t.Fatal("a bundle with nothing installed yet is an upgrade")
	}
	writeApp(t, filepath.Join(installDir, "app"), "1.2.3")
	if bundleUpgrades(root, installDir) {
		t.Fatal("the same version installed is not an upgrade, so the open window is focused")
	}
	writeApp(t, filepath.Join(installDir, "app"), "1.2.2")
	if !bundleUpgrades(root, installDir) {
		t.Fatal("a different installed version is an upgrade")
	}
}
