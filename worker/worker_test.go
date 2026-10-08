package inspectcontext

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func canonicalWorkerRoot(t *testing.T, root string) string {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func writeWorkerManifest(t *testing.T, root string, mode os.FileMode) string {
	t.Helper()
	root = canonicalWorkerRoot(t, root)
	path := filepath.Join(t.TempDir(), "manifest.json")
	data := []byte(fmt.Sprintf(`{"version":1,"root":%q}`, root))
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func invokeWorker(t *testing.T, root, query string) (researchPacket, string, error) {
	t.Helper()
	root = canonicalWorkerRoot(t, root)
	manifest := writeWorkerManifest(t, root, 0o600)
	input := []byte(fmt.Sprintf(`{"version":1,"root":%q,"query":%q}`, root, query))
	var output bytes.Buffer
	err := runProcess(bytes.NewReader(input), &output, manifest)
	if err != nil {
		return researchPacket{}, output.String(), err
	}
	var packet researchPacket
	if err := decodeStrict(output.Bytes(), &packet); err != nil {
		t.Fatalf("worker output was not strict JSON: %v", err)
	}
	if err := validatePacket(packet); err != nil {
		t.Fatalf("worker output failed packet validation: %v", err)
	}
	return packet, output.String(), nil
}

func writeWorkerFile(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func runWorkerGit(t *testing.T, root string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = root
	command.Env = gitEnvironment()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v: %s", args, err, output)
	}
}

func TestWorkerFilesystemPacketCoversEvidenceCategories(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "AGENTS.md", "Read this governing file.\n")
	writeWorkerFile(t, root, "definition.go", "func needle() {}\n")
	writeWorkerFile(t, root, "caller.go", "func run() { needle() }\n")
	writeWorkerFile(t, root, "import.go", "import needle \"module\"\n")
	writeWorkerFile(t, root, "tests/needle_test.go", "func Testneedle(t *T) {}\n")
	writeWorkerFile(t, root, "settings.json", "{\"needle\":true}\n")
	writeWorkerFile(t, root, "inert.txt", "echo needle; $(touch should-not-exist)\n")

	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		items []evidenceRef
	}{
		{"governing", packet.GoverningArtifacts},
		{"definitions", packet.Definitions},
		{"callers", packet.Callers},
		{"imports", packet.Imports},
		{"tests", packet.Tests},
		{"configuration", packet.Configuration},
		{"matches", packet.Matches},
	} {
		if len(test.items) == 0 {
			t.Errorf("%s evidence is empty", test.name)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("repository text was executed")
	}
	if packet.Target.Repository != "filesystem" || packet.Target.Root != "." {
		t.Fatalf("unexpected target: %+v", packet.Target)
	}
}

func TestWorkerGitInventoryExcludesIgnoredFiles(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, ".gitignore", "ignored/\n")
	writeWorkerFile(t, root, "tracked.go", "func needle() {}\n")
	writeWorkerFile(t, root, "ignored/needle.go", "func needle() {}\n")
	runWorkerGit(t, root, "add", "--", ".gitignore", "tracked.go")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.com", "commit", "--quiet", "-m", "initial")

	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	if packet.Target.Repository != "git" {
		t.Fatalf("repository kind = %q", packet.Target.Repository)
	}
	for _, item := range packet.Matches {
		if strings.Contains(item.Path, "ignored") {
			t.Fatalf("ignored path appeared in packet: %+v", item)
		}
	}
}

func runGitInitForWorker(root string) error {
	command := exec.Command("git", "init", "--quiet")
	command.Dir = root
	command.Env = gitEnvironment()
	return command.Run()
}

func markGitRoot(t *testing.T, root string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
}

func installFakeGit(t *testing.T, script string) {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "git")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nset -eu\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestWorkerSupportsUnbornGitRepository(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "untracked.go", "func needle() {}\n")

	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	if packet.Target.Repository != "git" || packet.Snapshot.Revision != nil {
		t.Fatalf("unexpected unborn Git packet: target=%+v snapshot=%+v", packet.Target, packet.Snapshot)
	}
	if len(packet.Matches) == 0 || packet.Matches[0].Path != "untracked.go" {
		t.Fatalf("untracked file was not searched: %+v", packet.Matches)
	}
}

func TestWorkerRecordsStableContentOmissions(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "binary.dat", "needle\x00data")
	writeWorkerFile(t, root, "invalid.txt", string([]byte{'n', 'e', 'e', 'd', 'l', 'e', '\xff'}))
	writeWorkerFile(t, root, "large.txt", strings.Repeat("needle\n", maxFileBytes/len("needle\n")+1))
	writeWorkerFile(t, root, "node_modules/package.js", "needle\n")
	writeWorkerFile(t, root, "build/generated.go", "needle\n")

	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	counts := make(map[string]int)
	for _, omission := range packet.Omissions {
		counts[omission.Reason] = omission.Count
	}
	for _, reason := range []string{"binary_file", "invalid_utf8", "oversized_file", "dependency_or_vendor", "generated_or_build"} {
		if counts[reason] != 1 {
			t.Errorf("omission %q count = %d", reason, counts[reason])
		}
	}
}

func TestWorkerRejectsUnsafeManifestAndCandidate(t *testing.T) {
	root := t.TempDir()
	canonicalRoot := canonicalWorkerRoot(t, root)
	manifest := writeWorkerManifest(t, canonicalRoot, 0o644)
	input := []byte(fmt.Sprintf(`{"version":1,"root":%q,"query":"needle"}`, canonicalRoot))
	var output bytes.Buffer
	if err := runProcess(bytes.NewReader(input), &output, manifest); err == nil || !strings.Contains(err.Error(), "mode 0600") {
		t.Fatalf("permission error = %v", err)
	}

	outside := t.TempDir()
	writeWorkerFile(t, outside, "secret.txt", "needle\n")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	manifest = writeWorkerManifest(t, canonicalRoot, 0o600)
	output.Reset()
	if err := runProcess(bytes.NewReader(input), &output, manifest); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("candidate symlink error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatal("unsafe candidate produced a packet")
	}

	otherRoot := t.TempDir()
	otherInput := []byte(fmt.Sprintf(`{"version":1,"root":%q,"query":"needle"}`, canonicalRoot))
	output.Reset()
	if err := runProcess(bytes.NewReader(otherInput), &output, writeWorkerManifest(t, otherRoot, 0o600)); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unauthorized root error = %v", err)
	}
}

func TestWorkerReportsNoMatchUncertainty(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "file.txt", "other\n")
	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	if len(packet.Matches) != 0 || !containsString(packet.Unknowns, "No literal matches were observed; this does not establish absence.") {
		t.Fatalf("no-match uncertainty missing: %+v", packet.Unknowns)
	}
}

func TestWorkerDetectsMutationBeforePacket(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "file.txt", "needle\n")
	canonicalRoot := canonicalWorkerRoot(t, root)
	repository, err := openAuthorizedRepository(canonicalRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repository.close() }()
	before, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	scan, err := scanInventory(repository, "needle", before)
	if err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "file.txt", "changed\n")
	after, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySnapshot(repository, before, after, scan.accepted); err == nil {
		t.Fatal("mutation was not detected")
	}
}

func TestWorkerPacketOrderingIsStable(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "z.txt", "needle\n")
	writeWorkerFile(t, root, "a.txt", "needle\n")
	first, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	first.Receipt.DurationMS = 0
	second.Receipt.DurationMS = 0
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("repeated scans were not deterministic:\nfirst=%+v\nsecond=%+v", first, second)
	}
}

func TestWorkerFitterKeepsCompactValidPacket(t *testing.T) {
	packet := researchPacket{
		Version:            1,
		Target:             packetTarget{Query: "needle", Root: ".", Repository: "filesystem"},
		Snapshot:           packetSnapshot{ID: "snapshot", Validated: true},
		GoverningArtifacts: []evidenceRef{}, Definitions: []evidenceRef{}, Callers: []evidenceRef{}, Imports: []evidenceRef{}, Tests: []evidenceRef{}, Configuration: []evidenceRef{}, Matches: []evidenceRef{},
		Excerpts: []excerpt{}, Unknowns: []string{"bounded"}, Omissions: []omissionGroup{},
	}
	for index := 0; index < maxExcerpts+10; index++ {
		id := fmt.Sprintf("e-%d", index)
		packet.Excerpts = append(packet.Excerpts, excerpt{ID: id, Path: fmt.Sprintf("file-%d.txt", index), StartLine: 1, EndLine: 1, Kind: "match", Text: strings.Repeat("needle ", 1000)})
		packet.Matches = append(packet.Matches, evidenceRef{ExcerptID: id, Path: fmt.Sprintf("file-%d.txt", index), StartLine: 1, EndLine: 1, Confidence: "observed", Reason: "literal match"})
	}
	packet = fitPacket(packet)
	packet.Receipt = receipt{PacketID: "packet", SchemaVersion: 1, PolicyVersion: policyVersion, SnapshotID: "snapshot", ExcerptCount: len(packet.Excerpts), OmissionCount: omissionTotal(packet.Omissions)}
	encoded, err := json.Marshal(packet)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > maxPacketBytes {
		t.Fatalf("fitted packet is %d bytes", len(encoded))
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerReadLimitDoesNotConsumeTrailingRequest(t *testing.T) {
	root := t.TempDir()
	writeWorkerFile(t, root, "file.txt", "needle\n")
	manifest := writeWorkerManifest(t, root, 0o600)
	input := io.MultiReader(bytes.NewBufferString(fmt.Sprintf(`{"version":1,"root":%q,"query":"needle"}`, root)), strings.NewReader("{}"))
	var output bytes.Buffer
	if err := runProcess(input, &output, manifest); err == nil {
		t.Fatal("trailing request value was accepted")
	}
}

func TestWorkerRejectsRawInvalidUTF8Request(t *testing.T) {
	root := t.TempDir()
	manifest := writeWorkerManifest(t, root, 0o600)
	input := append([]byte(fmt.Sprintf(`{"version":1,"root":%q,"query":"`, root)), 0xff)
	input = append(input, []byte(`"}`)...)
	var output bytes.Buffer
	if err := runProcess(bytes.NewReader(input), &output, manifest); err == nil || !strings.Contains(err.Error(), "valid UTF-8") {
		t.Fatalf("invalid UTF-8 error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatal("invalid UTF-8 request produced a packet")
	}
}

func TestWorkerRejectsOversizedRequest(t *testing.T) {
	root := t.TempDir()
	manifest := writeWorkerManifest(t, root, 0o600)
	input := bytes.Repeat([]byte("x"), maxRequestBytes+1)
	var output bytes.Buffer
	if err := runProcess(bytes.NewReader(input), &output, manifest); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized request error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatal("oversized request produced a packet")
	}
}

func TestWorkerRejectsUnsafeGitPaths(t *testing.T) {
	for _, test := range []struct {
		name string
		data []byte
	}{
		{name: "absolute", data: []byte("/absolute.txt\x00")},
		{name: "traversal", data: []byte("../escape.txt\x00")},
		{name: "nested traversal", data: []byte("dir/../escape.txt\x00")},
		{name: "missing terminal NUL", data: []byte("safe.txt")},
		{name: "empty record", data: []byte("safe.txt\x00\x00")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseGitPaths(test.data); err == nil {
				t.Fatal("unsafe Git record was accepted")
			}
		})
	}
}

func TestWorkerRejectsSymlinkedRootAndComponent(t *testing.T) {
	realRoot := t.TempDir()
	rootLink := filepath.Join(t.TempDir(), "root-link")
	if err := os.Symlink(realRoot, rootLink); err != nil {
		t.Fatal(err)
	}
	if _, err := openAuthorizedRepository(rootLink); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked root error = %v", err)
	}

	componentRoot := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(componentRoot, "component")); err != nil {
		t.Fatal(err)
	}
	if _, err := openAuthorizedRepository(filepath.Join(componentRoot, "component")); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked component error = %v", err)
	}

	outsideFile := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("needle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	candidateRoot := t.TempDir()
	if err := os.Symlink(outsideFile, filepath.Join(candidateRoot, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := invokeWorker(t, candidateRoot, "needle"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked candidate error = %v", err)
	}
}

func TestWorkerGitMetadataFailuresAreErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		script string
	}{
		{
			name: "rev-parse failure",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) exit 7;;
esac`,
		},
		{
			name: "mismatched top level",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) printf '/tmp\n';;
esac`,
		},
		{
			name: "malformed top level",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) printf '%s\nextra\n' "$PWD";;
esac`,
		},
		{
			name: "malformed HEAD",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) printf '%s\n' "$PWD";;
rev-parse:--verify) printf 'deadbeef\nextra\n';;
esac`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			markGitRoot(t, root)
			installFakeGit(t, test.script)
			if _, _, err := invokeWorker(t, root, "needle"); err == nil || !strings.Contains(err.Error(), "Git") {
				t.Fatalf("Git metadata error = %v", err)
			}
		})
	}
}

func TestWorkerGitInventoryFailureAndOverflow(t *testing.T) {
	for _, test := range []struct {
		name    string
		script  string
		message string
	}{
		{
			name: "command failure",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) printf '%s\n' "$PWD";;
rev-parse:--verify) printf 'deadbeef\n';;
ls-files:*) printf 'inventory failed\n' >&2; exit 9;;
esac`,
			message: "git inventory failed",
		},
		{
			name: "stdout overflow",
			script: `case "$1:$2" in
rev-parse:--show-toplevel) printf '%s\n' "$PWD";;
rev-parse:--verify) printf 'deadbeef\n';;
ls-files:*) exec /bin/dd if=/dev/zero bs=8388609 count=1 2>/dev/null;;
esac`,
			message: "git output exceeded configured limit",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			markGitRoot(t, root)
			installFakeGit(t, test.script)
			if _, _, err := invokeWorker(t, root, "needle"); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("Git inventory error = %v", err)
			}
		})
	}
}

func TestWorkerGitEnvironmentIsFixed(t *testing.T) {
	t.Setenv("INSPECT_CONTEXT_TEST_SECRET", "must-not-inherit")
	for _, value := range gitEnvironment() {
		key, _, ok := strings.Cut(value, "=")
		if ok && key == "INSPECT_CONTEXT_TEST_SECRET" {
			t.Fatal("arbitrary environment variable inherited by Git")
		}
	}
}

func TestWorkerSkipsExcludedSubtreesBeforeDescending(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("needle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "node_modules"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "node_modules", "link.txt")); err != nil {
		t.Fatal(err)
	}
	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	for _, omission := range packet.Omissions {
		if omission.Reason == "dependency_or_vendor" && omission.Count == 1 && containsString(omission.Examples, "node_modules") {
			return
		}
	}
	t.Fatalf("excluded subtree omission missing: %+v", packet.Omissions)
}

func TestWorkerFilesystemEntryLimit(t *testing.T) {
	root := t.TempDir()
	for index := 0; index <= maxFilesystemEntries; index++ {
		path := filepath.Join(root, fmt.Sprintf("file-%06d.txt", index))
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := invokeWorker(t, root, "needle"); err == nil || !strings.Contains(err.Error(), "filesystem entry traversal exceeded") {
		t.Fatalf("filesystem entry limit error = %v", err)
	}
}

func TestWorkerGoverningExcerptHasExactNewlineTerminatedRanges(t *testing.T) {
	for _, lines := range []int{1, 79, 80} {
		t.Run(fmt.Sprintf("%d-lines", lines), func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "AGENTS.md", strings.Repeat("governing\n", lines))
			packet, _, err := invokeWorker(t, root, "not-present")
			if err != nil {
				t.Fatal(err)
			}
			if len(packet.GoverningArtifacts) != 1 {
				t.Fatalf("governing refs = %+v", packet.GoverningArtifacts)
			}
			ref := packet.GoverningArtifacts[0]
			if ref.StartLine != 1 || ref.EndLine != lines {
				t.Fatalf("governing range = %d-%d, want 1-%d", ref.StartLine, ref.EndLine, lines)
			}
			var found *excerpt
			for index := range packet.Excerpts {
				if packet.Excerpts[index].ID == ref.ExcerptID {
					found = &packet.Excerpts[index]
					break
				}
			}
			if found == nil || lineCount(found.Text) != lines || found.EndLine != lines {
				t.Fatalf("governing excerpt = %+v", found)
			}
		})
	}
}

func TestWorkerFindsMultilineLiteralAndOmitsOverlongRange(t *testing.T) {
	t.Run("multiline", func(t *testing.T) {
		root := t.TempDir()
		writeWorkerFile(t, root, "source.txt", "prefix\nfirst\nsecond\nsuffix\n")
		packet, _, err := invokeWorker(t, root, "first\nsecond")
		if err != nil {
			t.Fatal(err)
		}
		if len(packet.Matches) != 1 {
			t.Fatalf("matches = %+v", packet.Matches)
		}
		match := packet.Matches[0]
		if match.StartLine != 2 || match.EndLine != 3 {
			t.Fatalf("multiline range = %d-%d", match.StartLine, match.EndLine)
		}
		for _, item := range packet.Excerpts {
			if item.ID == match.ExcerptID && item.Text != "first\nsecond\n" {
				t.Fatalf("multiline excerpt = %q", item.Text)
			}
		}
	})

	t.Run("overlong", func(t *testing.T) {
		root := t.TempDir()
		text := strings.Repeat("line\n", maxExcerptLines+1)
		writeWorkerFile(t, root, "source.txt", text)
		packet, _, err := invokeWorker(t, root, text)
		if err != nil {
			t.Fatal(err)
		}
		if len(packet.Matches) != 0 {
			t.Fatalf("overlong match was included: %+v", packet.Matches)
		}
		for _, omission := range packet.Omissions {
			if omission.Reason == "excerpt_limit" && omission.Count == 1 && containsString(omission.Examples, "source.txt") {
				return
			}
		}
		t.Fatalf("overlong match omission missing: %+v", packet.Omissions)
	})
}

func TestWorkerDeletedTrackedFileIsAnIneligibleOmission(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "tracked.txt", "needle\n")
	runWorkerGit(t, root, "add", "tracked.txt")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.com", "commit", "--quiet", "-m", "initial")
	if err := os.Remove(filepath.Join(root, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
	packet, _, err := invokeWorker(t, root, "needle")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, omission := range packet.Omissions {
		if omission.Reason == "ineligible_file" && omission.Count == 1 && containsString(omission.Examples, "tracked.txt") {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing tracked-file omission: %+v", packet.Omissions)
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
	writeWorkerFile(t, root, "tracked.txt", "needle\n")
	after, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySnapshot(repository, before, after, nil); err == nil || !strings.Contains(err.Error(), "snapshot changed") {
		t.Fatalf("restored tracked file mutation = %v", err)
	}
}

func TestWorkerDetectsHeadOnlyMutation(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "tracked.txt", "needle\n")
	runWorkerGit(t, root, "add", "tracked.txt")
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.com", "commit", "--quiet", "-m", "initial")
	repository, err := openAuthorizedRepository(canonicalWorkerRoot(t, root))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repository.close() }()
	before, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	runWorkerGit(t, root, "-c", "user.name=Inspect Context Test", "-c", "user.email=inspect-context@example.com", "commit", "--quiet", "--allow-empty", "-m", "second")
	after, err := collectInventory(repository)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySnapshot(repository, before, after, nil); err == nil || !strings.Contains(err.Error(), "snapshot changed") {
		t.Fatal("HEAD-only mutation was not detected")
	}
}

func TestWorkerScanBoundsRepeatedLiteralCandidates(t *testing.T) {
	root := t.TempDir()
	content := strings.Repeat("line\n", maxFileBytes/len("line\n"))
	fileCount := maxAggregateReadBytes / maxFileBytes
	totalMatches := fileCount * strings.Count(content, "\n")
	for index := 0; index < fileCount; index++ {
		writeWorkerFile(t, root, fmt.Sprintf("file-%03d.txt", index), content)
	}

	packet, _, err := invokeWorker(t, root, "\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(packet.Matches) != maxEvidencePerCategory || len(packet.Excerpts) != maxEvidencePerCategory {
		t.Fatalf("repeated literal candidates were not bounded: matches=%d excerpts=%d", len(packet.Matches), len(packet.Excerpts))
	}
	for _, omission := range packet.Omissions {
		if omission.Reason == "excerpt_limit" {
			if omission.Count != totalMatches-maxEvidencePerCategory {
				t.Fatalf("excerpt_limit count = %d, want %d", omission.Count, totalMatches-maxEvidencePerCategory)
			}
			return
		}
	}
	t.Fatal("repeated literal candidates had no exact excerpt_limit omission")
}

func TestWorkerDetectsScanTimeRootReplacement(t *testing.T) {
	root := t.TempDir()
	if err := runGitInitForWorker(root); err != nil {
		t.Fatal(err)
	}
	writeWorkerFile(t, root, "file.txt", "needle\n")
	installFakeGit(t, `
root=$(pwd -P)
marker="${root}.replacement-marker"
case "$1:$2" in
rev-parse:--show-toplevel) printf '%s\n' "$root";;
rev-parse:--verify) printf 'deadbeef\n';;
ls-files:*)
  printf 'file.txt\0'
  if [ -e "$marker" ]; then
    mv "$root" "${root}.old"
    mkdir "$root"
  else
    : > "$marker"
  fi
  ;;
esac`)
	manifest := writeWorkerManifest(t, root, 0o600)
	input := []byte(fmt.Sprintf(`{"version":1,"root":%q,"query":"needle"}`, canonicalWorkerRoot(t, root)))
	var output bytes.Buffer
	err := runProcess(bytes.NewReader(input), &output, manifest)
	if err == nil || !strings.Contains(err.Error(), "authorized root changed during scan") {
		t.Fatalf("root replacement error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatal("root replacement produced a packet")
	}
}

func TestWorkerFitterReservesQueryEvidenceAndFinalizesReceipt(t *testing.T) {
	governingText := strings.Repeat(strings.Repeat("x", 700)+"\n", maxExcerptLines)
	packet := researchPacket{
		Version:            1,
		Target:             packetTarget{Query: "needle", Root: ".", Repository: "filesystem"},
		Snapshot:           packetSnapshot{ID: "snapshot", Validated: true},
		GoverningArtifacts: []evidenceRef{{ExcerptID: "governing", Path: "AGENTS.md", StartLine: 1, EndLine: maxExcerptLines, Confidence: "observed", Reason: "governing artifact"}},
		Definitions:        []evidenceRef{}, Callers: []evidenceRef{}, Imports: []evidenceRef{}, Tests: []evidenceRef{}, Configuration: []evidenceRef{},
		Matches: []evidenceRef{{ExcerptID: "match", Path: "source.txt", StartLine: 1, EndLine: 1, Confidence: "observed", Reason: "literal match"}},
		Excerpts: []excerpt{
			{ID: "governing", Path: "AGENTS.md", StartLine: 1, EndLine: maxExcerptLines, Kind: "governing", Text: governingText},
			{ID: "match", Path: "source.txt", StartLine: 1, EndLine: 1, Kind: "match", Text: "needle\n"},
		},
		Unknowns: []string{"bounded"}, Omissions: []omissionGroup{},
		Receipt: receipt{PacketID: "packet", SchemaVersion: 1, PolicyVersion: policyVersion, SnapshotID: "snapshot", ExcerptCount: 999, OmissionCount: 999},
	}
	packet.Excerpts = sortExcerpts(packet.Excerpts)
	packet = fitPacket(packet)
	if len(packet.Matches) != 1 || len(packet.GoverningArtifacts) != 0 {
		t.Fatalf("query evidence was not reserved: %+v", packet)
	}
	if packet.Receipt.ExcerptCount != len(packet.Excerpts) || packet.Receipt.OmissionCount != omissionTotal(packet.Omissions) {
		t.Fatalf("stale receipt counts: %+v", packet.Receipt)
	}
	encoded, err := json.Marshal(packet)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > maxPacketBytes {
		t.Fatalf("fitted packet is %d bytes", len(encoded))
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
}
