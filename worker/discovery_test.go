package inspectcontext

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerGitConflictKeepsAvailableEvidence(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "conflict.go", "package fixture\nfunc originalNeedle() {}\n")
	writeWorkerFile(t, root, "available.go", "package fixture\nfunc availableNeedle() {}\n")
	runWorkerGit(t, root, "add", ".")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.invalid", "commit", "--quiet", "-m", "initial")
	runWorkerGit(t, root, "branch", "other")
	writeWorkerFile(t, root, "conflict.go", "package fixture\nfunc currentNeedle() {}\n")
	runWorkerGit(t, root, "add", ".")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.invalid", "commit", "--quiet", "-m", "current")
	runWorkerGit(t, root, "checkout", "--quiet", "other")
	writeWorkerFile(t, root, "conflict.go", "package fixture\nfunc otherNeedle() {}\n")
	runWorkerGit(t, root, "add", ".")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.invalid", "commit", "--quiet", "-m", "other")
	runWorkerGit(t, root, "checkout", "--quiet", "-")
	merge := exec.Command("git", "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.invalid", "merge", "--no-commit", "other")
	merge.Dir = root
	merge.Env = gitEnvironment()
	if output, err := merge.CombinedOutput(); err == nil || !strings.Contains(string(output), "CONFLICT") {
		t.Fatalf("expected a merge conflict, got %v: %s", err, output)
	}
	for _, query := range []string{"currentNeedle", "otherNeedle", "availableNeedle"} {
		t.Run(query, func(t *testing.T) {
			packet, _, err := invokeWorker(t, root, query)
			if err != nil {
				t.Fatal(err)
			}
			if len(packet.Excerpts) == 0 {
				t.Fatalf("no evidence for %s", query)
			}
		})
	}
}

func TestWorkerGitSparseCheckoutOmitsAbsentFiles(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "kept/available.go", "package fixture\nfunc sharedNeedle() {}\n")
	writeWorkerFile(t, root, "omitted/absent.go", "package fixture\nfunc sharedNeedle() {}\n")
	runWorkerGit(t, root, "add", ".")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.invalid", "commit", "--quiet", "-m", "initial")
	runWorkerGit(t, root, "sparse-checkout", "set", "--cone", "kept")
	if _, err := os.Stat(filepath.Join(root, "omitted", "absent.go")); !os.IsNotExist(err) {
		t.Fatalf("expected absent sparse file, got %v", err)
	}
	packet, _, err := invokeWorker(t, root, "sharedNeedle")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range packet.Excerpts {
		if item.Path == "omitted/absent.go" {
			t.Fatal("returned an absent file")
		}
		found = found || item.Path == "kept/available.go"
	}
	if !found {
		t.Fatal("missing available evidence")
	}
	omitted := false
	for _, omission := range packet.Omissions {
		omitted = omitted || omission.Reason == "ineligible_file" && containsString(omission.Examples, "omitted/absent.go")
	}
	if !omitted {
		t.Fatalf("missing sparse omission: %+v", packet.Omissions)
	}

	repository, err := openAuthorizedRepository(canonicalWorkerRoot(t, root))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repository.close() }()
	before, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "omitted/absent.go", "package fixture\nfunc restoredNeedle() {}\n")
	after, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySnapshot(repository, before, after, nil); err == nil {
		t.Fatal("restoring a sparse file during the scan did not invalidate the snapshot")
	}
}
