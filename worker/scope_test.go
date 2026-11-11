package inspectcontext

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func invokeScopeWorker(t *testing.T, root, cwd, query string) (researchPacket, error) {
	t.Helper()
	root = canonicalWorkerRoot(t, root)
	input, err := json.Marshal(map[string]any{"version": 1, "root": root, "cwd": cwd, "query": query})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err = runProcess(bytes.NewReader(input), &output, writeWorkerManifest(t, root, 0o600))
	if err != nil {
		return researchPacket{}, err
	}
	var packet researchPacket
	if err := decodeStrict(output.Bytes(), &packet); err != nil {
		t.Fatal(err)
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
	return packet, nil
}

func TestNearestPackageScopeAndThinFallback(t *testing.T) {
	for _, test := range []struct {
		name       string
		localFiles int
		marker     string
		fallback   bool
	}{
		{"enough local evidence", 3, "package.json", false},
		{"thin package", 2, "pyproject.toml", true},
		{"no package marker", 3, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "package.json", "{}\n")
			if test.marker != "" {
				writeWorkerFile(t, root, "services/billing/"+test.marker, "\n")
			}
			for index := 0; index < test.localFiles; index++ {
				writeWorkerFile(t, root, fmt.Sprintf("services/billing/src/source%d.py", index), "def scoped_needle():\n    pass\n")
			}
			writeWorkerFile(t, root, "services/invoicing/source.py", "def scoped_needle():\n    pass\n")
			packet, err := invokeScopeWorker(t, root, "services/billing/src", "scoped_needle")
			if err != nil {
				t.Fatalf("expected accepted cwd-scoped request: %v", err)
			}
			sibling := false
			for _, excerpt := range packet.Excerpts {
				if excerpt.Path == "services/invoicing/source.py" {
					sibling = true
				}
			}
			if sibling != test.fallback {
				t.Fatalf("sibling evidence = %t, want %t", sibling, test.fallback)
			}
			if !test.fallback {
				rootPacket, err := invokeScopeWorker(t, root, ".", "scoped_needle")
				if err != nil {
					t.Fatal(err)
				}
				if rootPacket.Receipt.PacketID == packet.Receipt.PacketID {
					t.Fatal("different package scopes must have different packet identities")
				}
			}
			if test.marker != "" {
				notes := strings.Join(packet.Unknowns, "\n")
				if !strings.Contains(notes, "services/billing") || (strings.Contains(notes, "fallback") != test.fallback) {
					t.Fatalf("missing explicit scope or fallback: %v", packet.Unknowns)
				}
			}
			if packet.Target.Root != "." || !packet.Snapshot.Validated {
				t.Fatalf("root-relative certified packet changed: %+v", packet)
			}
		})
	}
}

func TestPackageAdmissionPrecedesSiblingCandidateCap(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "z-package/go.mod", "module example\n")
	for index := 0; index < 3; index++ {
		writeWorkerFile(t, root, fmt.Sprintf("z-package/source%d.go", index), "func scoped_needle() {}\n")
	}
	for index := 0; index < maxGitCleanCandidates+1; index++ {
		writeWorkerFile(t, root, fmt.Sprintf("a-sibling/source%03d.go", index), "func scoped_needle() {}\n")
	}
	runWorkerGit(t, root, "init", "--quiet")
	runWorkerGit(t, root, "add", "-A")
	runWorkerGit(t, root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture")
	packet, err := invokeScopeWorker(t, root, "z-package", "scoped_needle")
	if err != nil {
		t.Fatalf("expected accepted cwd-scoped request: %v", err)
	}
	if len(packet.Definitions) != 3 {
		t.Fatalf("local definitions lost to sibling admission: %+v", packet.Definitions)
	}
	for _, definition := range packet.Definitions {
		if !strings.HasPrefix(definition.Path, "z-package/") {
			t.Fatalf("sibling displaced local definition: %+v", definition)
		}
	}
	if packet.Receipt.DiscoveredFiles > maxDiscoveredFiles || packet.Receipt.BytesRead > maxAggregateReadBytes {
		t.Fatalf("global scan bounds changed: %+v", packet.Receipt)
	}
}

func TestScopeCwdRejectsEscapesAndSymlinks(t *testing.T) {
	for _, cwd := range []string{"../outside", "/tmp", "app/../outside", "app/source.py", "link", "missing"} {
		t.Run(cwd, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "app/source.py", "def needle():\n    pass\n")
			if cwd == "link" {
				if err := os.Symlink(t.TempDir(), filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := invokeScopeWorker(t, root, cwd, "needle"); err == nil {
				t.Fatalf("expected unsafe or non-directory cwd %q to be rejected", cwd)
			}
		})
	}
}
