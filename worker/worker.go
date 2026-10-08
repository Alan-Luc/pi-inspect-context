package inspectcontext

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxRequestBytes      = 64 * 1024
	maxManifestBytes     = 64 * 1024
	maxFileBytes         = 64 * 1024
	maxPathBytes         = 4096
	maxGitOutputBytes    = 8 * 1024 * 1024
	maxGitStderrBytes    = 64 * 1024
	maxFilesystemEntries = 100_000
	maxExamplePathBytes  = 256
)

type workerError struct {
	code string
	err  error
}

func (e *workerError) Error() string { return e.code + ": " + e.err.Error() }
func (e *workerError) Unwrap() error { return e.err }

func workerFailure(code, format string, args ...interface{}) error {
	return &workerError{code: code, err: fmt.Errorf(format, args...)}
}

func withWorkerCode(code string, err error) error {
	if err == nil {
		return nil
	}
	var coded *workerError
	if errors.As(err, &coded) {
		return err
	}
	return &workerError{code: code, err: err}
}

func Run() error {
	manifestPath := os.Getenv("INSPECT_CONTEXT_MANIFEST")
	return runProcess(os.Stdin, os.Stdout, manifestPath)
}

func runProcess(input io.Reader, output io.Writer, manifestPath string) (runErr error) {
	started := time.Now()
	if err := validateManifestPath(manifestPath); err != nil {
		return workerFailure("authorization", "%v", err)
	}
	manifest, err := loadWorkerManifest(manifestPath)
	if err != nil {
		return withWorkerCode("authorization", err)
	}
	requestBytes, err := readLimited(input, maxRequestBytes)
	if err != nil {
		return workerFailure("protocol", "read request: %v", err)
	}
	if !utf8.Valid(requestBytes) {
		return workerFailure("protocol", "request must be valid UTF-8")
	}
	if err := strictJSONShape(requestBytes); err != nil {
		return workerFailure("protocol", "request JSON shape: %v", err)
	}
	var request workerRequest
	if err := decodeStrict(requestBytes, &request); err != nil {
		return workerFailure("protocol", "decode request: %v", err)
	}
	if err := validateRequest(request); err != nil {
		return workerFailure("protocol", "%v", err)
	}
	if !utf8.ValidString(request.Query) {
		return workerFailure("protocol", "query must be valid UTF-8")
	}
	if request.Root != manifest.Root {
		return workerFailure("authorization", "request root is not authorized by manifest")
	}

	repository, err := openAuthorizedRepository(request.Root)
	if err != nil {
		return withWorkerCode("root", err)
	}
	defer func() {
		if closeErr := repository.close(); closeErr != nil && runErr == nil {
			runErr = withWorkerCode("root", closeErr)
		}
	}()

	initial, err := collectInventory(repository)
	if err != nil {
		return withWorkerCode("inventory", err)
	}
	result, err := scanInventory(repository, request.Query, initial)
	if err != nil {
		return withWorkerCode("scan", err)
	}
	final, err := collectInventory(repository)
	if err != nil {
		return workerFailure("snapshot_changed", "final inventory: %v", err)
	}
	if err := verifySnapshot(repository, initial, final, result.accepted); err != nil {
		return withWorkerCode("snapshot_changed", err)
	}

	packet, err := makePacket(request, initial, result, started)
	if err != nil {
		return withWorkerCode("packet_limit", err)
	}
	encoded, err := json.Marshal(packet)
	if err != nil {
		return workerFailure("output", "encode packet: %v", err)
	}
	if len(encoded) > maxPacketBytes {
		return workerFailure("packet_limit", "packet exceeds %d bytes", maxPacketBytes)
	}
	if _, err := output.Write(encoded); err != nil {
		return workerFailure("output", "write packet: %v", err)
	}
	return nil
}

func strictJSONShape(data []byte) error {
	if !json.Valid(data) {
		return errors.New("invalid JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := walkJSONValue(decoder); err != nil {
		return err
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			keys := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				if _, exists := keys[key]; exists {
					return fmt.Errorf("duplicate object key %q", key)
				}
				keys[key] = struct{}{}
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return errors.New("object did not close")
			}
		case '[':
			for decoder.More() {
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return errors.New("array did not close")
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
	}
	return nil
}

func validateManifestPath(value string) error {
	if value == "" || strings.IndexByte(value, 0) >= 0 || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return errors.New("INSPECT_CONTEXT_MANIFEST must be a clean, NUL-free absolute path")
	}
	info, err := os.Lstat(value)
	if err != nil {
		return fmt.Errorf("inspect manifest: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("inspect manifest must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("inspect manifest must be mode 0600 or stricter")
	}
	return nil
}

func loadWorkerManifest(path string) (authorizationManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return authorizationManifest{}, fmt.Errorf("open inspect manifest: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return authorizationManifest{}, fmt.Errorf("stat inspect manifest: %w", err)
	}
	data, readErr := readLimited(file, maxManifestBytes)
	closeErr := file.Close()
	if readErr != nil {
		return authorizationManifest{}, fmt.Errorf("read inspect manifest: %w", readErr)
	}
	if closeErr != nil {
		return authorizationManifest{}, fmt.Errorf("close inspect manifest: %w", closeErr)
	}
	current, err := os.Lstat(path)
	if err != nil || current.Mode()&os.ModeSymlink != 0 || !current.Mode().IsRegular() || current.Mode().Perm()&0o077 != 0 || !os.SameFile(info, current) {
		return authorizationManifest{}, errors.New("inspect manifest changed during authorization")
	}
	if err := strictJSONShape(data); err != nil {
		return authorizationManifest{}, fmt.Errorf("inspect manifest JSON shape: %w", err)
	}
	var manifest authorizationManifest
	if err := decodeStrict(data, &manifest); err != nil {
		return authorizationManifest{}, fmt.Errorf("decode inspect manifest: %w", err)
	}
	if err := validateManifest(manifest); err != nil {
		return authorizationManifest{}, err
	}
	canonical, err := filepath.EvalSymlinks(manifest.Root)
	if err != nil {
		return authorizationManifest{}, fmt.Errorf("resolve manifest root: %w", err)
	}
	if canonical != manifest.Root {
		return authorizationManifest{}, errors.New("manifest root must be canonical and symlink-free")
	}
	return manifest, nil
}

type openedRepository struct {
	path      string
	root      *os.Root
	directory *os.File
	identity  os.FileInfo
}

func openAuthorizedRepository(path string) (*openedRepository, error) {
	if err := validateNoSymlinkComponents(path); err != nil {
		return nil, err
	}
	identity, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("lstat authorized root: %w", err)
	}
	if identity.Mode()&os.ModeSymlink != 0 || !identity.IsDir() {
		return nil, errors.New("authorized root must be a real directory")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, fmt.Errorf("open authorized root: %w", err)
	}
	directory, err := os.Open(path)
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("open authorized directory: %w", err)
	}
	openedInfo, err := directory.Stat()
	if err != nil {
		_ = directory.Close()
		_ = root.Close()
		return nil, fmt.Errorf("stat authorized directory: %w", err)
	}
	if !os.SameFile(identity, openedInfo) {
		_ = directory.Close()
		_ = root.Close()
		return nil, errors.New("authorized root changed during open")
	}
	return &openedRepository{path: path, root: root, directory: directory, identity: identity}, nil
}

func (r *openedRepository) close() error {
	directoryErr := r.directory.Close()
	rootErr := r.root.Close()
	if directoryErr != nil && rootErr != nil {
		return fmt.Errorf("close directory: %v; close root: %v", directoryErr, rootErr)
	}
	if directoryErr != nil {
		return fmt.Errorf("close directory: %w", directoryErr)
	}
	if rootErr != nil {
		return fmt.Errorf("close root: %w", rootErr)
	}
	return nil
}

func validateNoSymlinkComponents(path string) error {
	volume := filepath.VolumeName(path)
	remaining := strings.TrimPrefix(path, volume)
	remaining = strings.TrimPrefix(remaining, string(filepath.Separator))
	current := volume + string(filepath.Separator)
	if volume == "" && !strings.HasPrefix(path, string(filepath.Separator)) {
		return errors.New("path must be absolute")
	}
	if remaining == "" {
		return nil
	}
	for _, part := range strings.Split(remaining, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("unsafe path component %q", part)
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("lstat path component %q: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path component %q is a symlink", current)
		}
	}
	return nil
}

func readLimited(reader io.Reader, limit int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, fmt.Errorf("input exceeds %d bytes", limit)
	}
	return data, nil
}

type repositoryInventory struct {
	kind        string
	entries     []inventoryEntry
	fingerprint string
	revision    *string
}

type inventoryEntry struct {
	path     string
	info     os.FileInfo
	excluded string
}

func collectInventory(repository *openedRepository) (repositoryInventory, error) {
	kind, revision, err := detectRepository(repository)
	if err != nil {
		return repositoryInventory{}, err
	}
	var entries []inventoryEntry
	if kind == "git" {
		entries, err = collectGitInventory(repository)
	} else {
		entries, err = collectFilesystemInventory(repository)
	}
	if err != nil {
		return repositoryInventory{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	return repositoryInventory{kind: kind, entries: entries, fingerprint: inventoryFingerprint(entries), revision: revision}, nil
}

func detectRepository(repository *openedRepository) (string, *string, error) {
	marker, err := repository.root.Lstat(".git")
	if errors.Is(err, fs.ErrNotExist) {
		return "filesystem", nil, nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("inspect Git marker: %w", err)
	}
	if marker.Mode()&os.ModeSymlink != 0 {
		return "", nil, errors.New("Git marker is a symlink")
	}
	result, err := runGit(repository, []string{"rev-parse", "--show-toplevel"}, 4096)
	if err != nil {
		return "", nil, fmt.Errorf("Git rev-parse show-toplevel: %w", err)
	}
	if result.code != 0 {
		return "", nil, fmt.Errorf("Git rev-parse show-toplevel failed with exit code %d: %s", result.code, strings.TrimSpace(string(result.stderr)))
	}
	top, err := parseGitLine(result.stdout, "Git top-level")
	if err != nil {
		return "", nil, err
	}
	if !filepath.IsAbs(top) || filepath.Clean(top) != top {
		return "", nil, fmt.Errorf("Git top-level is not a clean absolute path: %q", top)
	}
	canonical, err := filepath.EvalSymlinks(top)
	if err != nil {
		return "", nil, fmt.Errorf("resolve Git top-level %q: %w", top, err)
	}
	if canonical != repository.path {
		return "", nil, fmt.Errorf("Git top-level %q does not match authorized root %q", canonical, repository.path)
	}
	revisionResult, err := runGit(repository, []string{"rev-parse", "--verify", "--quiet", "HEAD"}, 4096)
	if err != nil {
		return "", nil, fmt.Errorf("Git rev-parse HEAD: %w", err)
	}
	if revisionResult.code == 1 && len(revisionResult.stdout) == 0 && len(revisionResult.stderr) == 0 {
		return "git", nil, nil
	}
	if revisionResult.code != 0 {
		return "", nil, fmt.Errorf("Git rev-parse HEAD failed with exit code %d: %s", revisionResult.code, strings.TrimSpace(string(revisionResult.stderr)))
	}
	value, err := parseGitLine(revisionResult.stdout, "Git HEAD")
	if err != nil {
		return "", nil, err
	}
	return "git", &value, nil
}

func parseGitLine(data []byte, label string) (string, error) {
	if len(data) == 0 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || data[len(data)-1] != '\n' {
		return "", fmt.Errorf("%s output is malformed", label)
	}
	value := strings.TrimSuffix(string(data), "\n")
	if value == "" || strings.ContainsAny(value, "\r\n") || strings.TrimSpace(value) != value {
		return "", fmt.Errorf("%s output is malformed", label)
	}
	return value, nil
}

func collectGitInventory(repository *openedRepository) ([]inventoryEntry, error) {
	result, err := runGit(repository, []string{"ls-files", "--cached", "--others", "--exclude-standard", "-z"}, maxGitOutputBytes)
	if err != nil {
		return nil, err
	}
	if result.code != 0 {
		return nil, fmt.Errorf("git inventory failed: %s", strings.TrimSpace(string(result.stderr)))
	}
	paths, err := parseGitPaths(result.stdout)
	if err != nil {
		return nil, err
	}
	entries := make([]inventoryEntry, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if _, ok := seen[path]; ok {
			return nil, fmt.Errorf("git inventory contains duplicate path %q", path)
		}
		seen[path] = struct{}{}
		info, err := lstatRepositoryPath(repository.root, path)
		if errors.Is(err, fs.ErrNotExist) {
			entries = append(entries, inventoryEntry{path: path, excluded: "ineligible_file"})
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("candidate path %q is a symlink", path)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("candidate path %q is not a regular file", path)
		}
		entries = append(entries, inventoryEntry{path: path, info: info, excluded: exclusionReason(path)})
	}
	return entries, nil
}

func collectFilesystemInventory(repository *openedRepository) ([]inventoryEntry, error) {
	entries := make([]inventoryEntry, 0)
	entryCount := 0
	err := fs.WalkDir(repository.root.FS(), ".", func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("walk %q: %w", path, walkErr)
		}
		if path == "." {
			return nil
		}
		entryCount++
		if entryCount > maxFilesystemEntries {
			return fmt.Errorf("filesystem entry traversal exceeded %d entries", maxFilesystemEntries)
		}
		if !safeRepositoryPath(path) {
			return fmt.Errorf("filesystem inventory contains unsafe path %q", path)
		}
		info, err := lstatRepositoryPath(repository.root, path)
		if err != nil {
			return fmt.Errorf("inspect filesystem entry %q: %w", path, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("filesystem candidate path %q is a symlink", path)
		}
		if item.IsDir() {
			if !info.IsDir() {
				return fmt.Errorf("filesystem directory changed: %q", path)
			}
			if reason := exclusionReasonForDirectory(path); reason != "" {
				entries = append(entries, inventoryEntry{path: path, info: info, excluded: reason})
				return fs.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("filesystem candidate path %q is not a regular file", path)
		}
		entries = append(entries, inventoryEntry{path: path, info: info, excluded: exclusionReason(path)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func parseGitPaths(data []byte) ([]string, error) {
	if len(data) == 0 {
		return []string{}, nil
	}
	if data[len(data)-1] != 0 {
		return nil, errors.New("git inventory is not NUL terminated")
	}
	parts := bytes.Split(data[:len(data)-1], []byte{0})
	paths := make([]string, 0, len(parts))
	for _, part := range parts {
		value := string(part)
		if !safeRepositoryPath(value) {
			return nil, fmt.Errorf("git inventory contains unsafe path %q", value)
		}
		paths = append(paths, value)
	}
	return paths, nil
}

func safeRepositoryPath(value string) bool {
	if value == "" || len([]byte(value)) > maxPathBytes || strings.IndexByte(value, 0) >= 0 || strings.ContainsRune(value, '\\') || strings.HasPrefix(value, "/") || !utf8.ValidString(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func lstatRepositoryPath(root *os.Root, value string) (os.FileInfo, error) {
	if !safeRepositoryPath(value) {
		return nil, fmt.Errorf("unsafe repository path %q", value)
	}
	parts := strings.Split(value, "/")
	for i := range parts {
		current := strings.Join(parts[:i+1], "/")
		info, err := root.Lstat(current)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("repository path component %q is a symlink", current)
		}
		if i < len(parts)-1 && !info.IsDir() {
			return nil, fmt.Errorf("repository path component %q is not a directory", current)
		}
	}
	return root.Lstat(value)
}

var (
	dependencyDirectoryNames = map[string]struct{}{
		".git": {}, "node_modules": {}, "vendor": {}, "third_party": {}, "deps": {}, "Pods": {},
	}
	generatedDirectoryNames = map[string]struct{}{
		"dist": {}, "build": {}, "out": {}, "target": {}, "coverage": {}, ".cache": {}, ".next": {},
		"tmp": {}, "bin": {}, "generated": {},
	}
)

func exclusionReason(value string) string {
	parts := strings.Split(value, "/")
	return exclusionReasonForParts(parts[:len(parts)-1])
}

func exclusionReasonForDirectory(value string) string {
	return exclusionReasonForParts(strings.Split(value, "/"))
}

func exclusionReasonForParts(parts []string) string {
	for _, part := range parts {
		if _, ok := dependencyDirectoryNames[part]; ok {
			return "dependency_or_vendor"
		}
		if _, ok := generatedDirectoryNames[part]; ok {
			return "generated_or_build"
		}
	}
	return ""
}

func governingName(value string) bool {
	name := filepath.Base(filepath.FromSlash(value))
	switch name {
	case "AGENTS.md", "README", "README.md", "README.txt", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "Makefile", "CMakeLists.txt", "pom.xml", "build.gradle":
		return true
	default:
		return false
	}
}

type fileFingerprint struct {
	path    string
	mode    os.FileMode
	size    int64
	modTime int64
}

func fingerprintFor(path string, info os.FileInfo) fileFingerprint {
	return fileFingerprint{path: path, mode: info.Mode(), size: info.Size(), modTime: info.ModTime().UnixNano()}
}

func inventoryFingerprint(entries []inventoryEntry) string {
	hash := sha256.New()
	for _, entry := range entries {
		if entry.info == nil {
			fmt.Fprintf(hash, "%s\x00missing\x00%s\x00", entry.path, entry.excluded)
			continue
		}
		fingerprint := fingerprintFor(entry.path, entry.info)
		fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00%s\x00", fingerprint.path, fingerprint.mode, fingerprint.size, fingerprint.modTime, entry.excluded)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func verifySnapshot(repository *openedRepository, before, after repositoryInventory, accepted map[string]fileFingerprint) error {
	if before.kind != after.kind || !sameRevision(before.revision, after.revision) || before.fingerprint != after.fingerprint {
		return errors.New("repository snapshot changed during scan")
	}
	currentRoot, err := os.Lstat(repository.path)
	if err != nil || currentRoot.Mode()&os.ModeSymlink != 0 || !os.SameFile(repository.identity, currentRoot) {
		return errors.New("authorized root changed during scan")
	}
	for path, expected := range accepted {
		info, err := lstatRepositoryPath(repository.root, path)
		if err != nil {
			return fmt.Errorf("accepted file %q changed during scan: %w", path, err)
		}
		actual := fingerprintFor(path, info)
		if actual != expected {
			return fmt.Errorf("accepted file %q changed during scan", path)
		}
	}
	return nil
}

func sameRevision(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

type scanResult struct {
	store      *evidenceStore
	unknowns   []string
	omissions  *omissionAccumulator
	accepted   map[string]fileFingerprint
	readFiles  int
	bytesRead  int64
	matchCount int
	ambiguous  bool
}

func scanInventory(repository *openedRepository, query string, inventory repositoryInventory) (scanResult, error) {
	result := scanResult{
		store:     newEvidenceStore(),
		omissions: newOmissionAccumulator(),
		accepted:  make(map[string]fileFingerprint),
	}
	eligible := make([]inventoryEntry, 0, len(inventory.entries))
	for _, entry := range inventory.entries {
		if entry.excluded != "" {
			result.omissions.add(entry.excluded, entry.path)
			continue
		}
		eligible = append(eligible, entry)
	}
	if len(eligible) > maxDiscoveredFiles {
		result.omissions.addCount("file_limit", len(eligible)-maxDiscoveredFiles, nil)
		eligible = eligible[:maxDiscoveredFiles]
	}
	for _, entry := range eligible {
		if entry.info.Size() > maxFileBytes {
			result.omissions.add("oversized_file", entry.path)
			continue
		}
		if result.bytesRead+entry.info.Size() > maxAggregateReadBytes {
			result.omissions.add("aggregate_byte_limit", entry.path)
			continue
		}
		data, info, err := readRepositoryFile(repository.root, entry.path, entry.info)
		if err != nil {
			if errors.Is(err, errSnapshotChanged) {
				return scanResult{}, err
			}
			result.omissions.add("read_error", entry.path)
			continue
		}
		result.readFiles++
		result.bytesRead += int64(len(data))
		result.accepted[entry.path] = fingerprintFor(entry.path, info)
		if bytes.IndexByte(data, 0) >= 0 {
			result.omissions.add("binary_file", entry.path)
			continue
		}
		if !utf8.Valid(data) {
			result.omissions.add("invalid_utf8", entry.path)
			continue
		}
		text := string(data)
		if governingName(entry.path) {
			if excerptText := firstLines(text, maxExcerptLines); excerptText != "" {
				if !result.store.add("governing", entry.path, 1, lineCount(excerptText), excerptText, "observed", "governing artifact") {
					result.omissions.add("excerpt_limit", entry.path)
				}
			}
		}
		forEachLiteralMatch(text, query, func(match literalMatch) {
			result.matchCount++
			lineSpan := match.endLine - match.startLine + 1
			if lineSpan > maxExcerptLines {
				result.omissions.add("excerpt_limit", entry.path)
				return
			}
			discarded := !result.store.add("match", entry.path, match.startLine, match.endLine, match.text, "observed", "literal match")
			lineText := strings.TrimSuffix(match.text, "\n")
			categories := classifyMatch(entry.path, lineText, query)
			if len(categories) > 1 {
				result.ambiguous = true
			}
			for _, category := range categories {
				if !result.store.add(category.kind, entry.path, match.startLine, match.endLine, match.text, category.confidence, category.reason) {
					discarded = true
				}
			}
			if discarded {
				result.omissions.add("excerpt_limit", entry.path)
			}
		})
	}
	if result.matchCount == 0 {
		result.unknowns = append(result.unknowns, "No literal matches were observed; this does not establish absence.")
	}
	result.unknowns = append(result.unknowns, "Definitions, callers, and imports are lexical candidates rather than a semantic call graph.")
	if result.ambiguous {
		result.unknowns = append(result.unknowns, "Some matches fit more than one lexical heuristic; inspect surrounding code.")
	}
	if result.omissions.total() > 0 {
		result.unknowns = append(result.unknowns, "Some files or evidence were omitted by bounded scanning; zero results do not prove absence.")
	}
	return result, nil
}

var errSnapshotChanged = errors.New("snapshot changed")

func readRepositoryFile(root *os.Root, path string, expected os.FileInfo) ([]byte, os.FileInfo, error) {
	before, err := lstatRepositoryPath(root, path)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: inspect %q: %v", errSnapshotChanged, path, err)
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() || !os.SameFile(before, expected) {
		return nil, nil, fmt.Errorf("%w: file %q changed before read", errSnapshotChanged, path)
	}
	file, err := root.Open(path)
	if err != nil {
		return nil, nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxFileBytes))
	closeErr := file.Close()
	if readErr != nil {
		return nil, nil, readErr
	}
	if closeErr != nil {
		return nil, nil, closeErr
	}
	openedInfo, err := fileInfoFromRoot(root, path)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: inspect %q after read: %v", errSnapshotChanged, path, err)
	}
	if !os.SameFile(before, openedInfo) || openedInfo.Size() != expected.Size() || openedInfo.ModTime() != expected.ModTime() || int64(len(data)) != openedInfo.Size() {
		return nil, nil, fmt.Errorf("%w: file %q changed during read", errSnapshotChanged, path)
	}
	return data, openedInfo, nil
}

func fileInfoFromRoot(root *os.Root, path string) (os.FileInfo, error) {
	info, err := lstatRepositoryPath(root, path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("path is no longer a regular file")
	}
	return info, nil
}

func sourceLines(value string) []string {
	if value == "" {
		return []string{}
	}
	lines := strings.SplitAfter(value, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		return lines[:len(lines)-1]
	}
	return lines
}

type literalMatch struct {
	startLine int
	endLine   int
	text      string
}

func forEachLiteralMatch(text, query string, visit func(literalMatch)) {
	if text == "" || query == "" {
		return
	}
	lines := sourceLines(text)
	starts := make([]int, len(lines))
	offset := 0
	for index, line := range lines {
		starts[index] = offset
		offset += len(line)
	}
	lastStartLine, lastEndLine := 0, 0
	for offset := strings.Index(text, query); offset >= 0; {
		endOffset := offset + len(query) - 1
		startLine := sourceLineNumber(starts, offset)
		endLine := sourceLineNumber(starts, endOffset)
		if startLine != lastStartLine || endLine != lastEndLine {
			lineStart := starts[startLine-1]
			lineEnd := starts[endLine-1] + len(lines[endLine-1])
			visit(literalMatch{startLine: startLine, endLine: endLine, text: text[lineStart:lineEnd]})
			lastStartLine, lastEndLine = startLine, endLine
		}
		next := offset + 1
		if next >= len(text) {
			break
		}
		relative := strings.Index(text[next:], query)
		if relative < 0 {
			break
		}
		offset = next + relative
	}
}

func sourceLineNumber(starts []int, offset int) int {
	return sort.Search(len(starts), func(index int) bool { return starts[index] > offset })
}

func lineCount(value string) int {
	return len(sourceLines(value))
}

func firstLines(value string, limit int) string {
	lines := sourceLines(value)
	if len(lines) > limit {
		lines = lines[:limit]
	}
	return strings.Join(lines, "")
}

type matchCategory struct {
	kind       string
	confidence string
	reason     string
}

func classifyMatch(path, line, query string) []matchCategory {
	if isTestPath(path) {
		return []matchCategory{{kind: "test", confidence: "observed", reason: "test path match"}}
	}
	if isConfigurationPath(path) {
		return []matchCategory{{kind: "configuration", confidence: "observed", reason: "configuration path match"}}
	}
	categories := make([]matchCategory, 0, 2)
	if isImportLine(line) {
		categories = append(categories, matchCategory{kind: "import", confidence: "candidate", reason: "import/include/use/require line"})
	}
	if isDefinitionLine(line, query) {
		categories = append(categories, matchCategory{kind: "definition", confidence: "candidate", reason: "declaration-like definition"})
	}
	if isCallLine(line, query) && !isDefinitionLine(line, query) {
		categories = append(categories, matchCategory{kind: "caller", confidence: "candidate", reason: "call shape"})
	}
	return categories
}

func isTestPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "/test/") || strings.HasPrefix(lower, "test/") || strings.Contains(lower, "/tests/") || strings.HasPrefix(lower, "tests/") || strings.HasSuffix(lower, "_test.go") || strings.Contains(lower, ".test.") || strings.Contains(lower, ".spec.")
}

func isConfigurationPath(path string) bool {
	lower := strings.ToLower(path)
	for _, suffix := range []string{".json", ".yaml", ".yml", ".toml", ".ini", ".xml", ".config", ".env"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return governingName(path)
}

func isImportLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	for _, prefix := range []string{"import ", "import{", "from ", "#include ", "include ", "using ", "use ", "require("} {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

func isDefinitionLine(line, query string) bool {
	trimmed := strings.TrimSpace(line)
	for _, keyword := range []string{"func ", "function ", "class ", "interface ", "struct ", "type ", "const ", "let ", "var ", "def ", "fn ", "export function ", "export class "} {
		if strings.Contains(trimmed, keyword+query) {
			return true
		}
	}
	index := strings.Index(line, query)
	if index < 0 {
		return false
	}
	rest := strings.TrimSpace(line[index+len(query):])
	return strings.HasPrefix(rest, ":=") || strings.HasPrefix(rest, "=")
}

func isCallLine(line, query string) bool {
	index := strings.Index(line, query)
	if index < 0 {
		return false
	}
	rest := strings.TrimSpace(line[index+len(query):])
	return strings.HasPrefix(rest, "(")
}

type evidenceStore struct {
	excerpts      []excerpt
	categories    map[string][]evidenceRef
	seen          map[string]string
	referenceSeen map[string]struct{}
}

func newEvidenceStore() *evidenceStore {
	return &evidenceStore{excerpts: make([]excerpt, 0), categories: map[string][]evidenceRef{
		"governing": {}, "definition": {}, "caller": {}, "import": {}, "test": {}, "configuration": {}, "match": {},
	}, seen: make(map[string]string), referenceSeen: make(map[string]struct{})}
}

func (s *evidenceStore) add(kind, path string, startLine, endLine int, text, confidence, reason string) bool {
	category, ok := s.categories[kind]
	if !ok {
		return false
	}
	key := strings.Join([]string{kind, path, fmt.Sprint(startLine), fmt.Sprint(endLine), text}, "\x00")
	id, exists := s.seen[key]
	if !exists {
		digest := sha256.Sum256([]byte(key))
		id = "e-" + hex.EncodeToString(digest[:8])
	}
	reference := evidenceRef{ExcerptID: id, Path: path, StartLine: startLine, EndLine: endLine, Confidence: confidence, Reason: reason}
	referenceKey := strings.Join([]string{kind, id, confidence, reason}, "\x00")
	if _, alreadyAdded := s.referenceSeen[referenceKey]; alreadyAdded {
		return true
	}
	if len(category) >= maxEvidencePerCategory {
		return false
	}
	if !exists {
		s.seen[key] = id
		s.excerpts = append(s.excerpts, excerpt{ID: id, Path: path, StartLine: startLine, EndLine: endLine, Kind: kind, Text: text})
	}
	s.referenceSeen[referenceKey] = struct{}{}
	s.categories[kind] = append(category, reference)
	return true
}

func (s *evidenceStore) packetCategories() ([][]evidenceRef, int) {
	values := make([][]evidenceRef, 7)
	pruned := 0
	for index, kind := range []string{"governing", "definition", "caller", "import", "test", "configuration", "match"} {
		values[index] = append([]evidenceRef(nil), s.categories[kind]...)
		if values[index] == nil {
			values[index] = []evidenceRef{}
		}
		sort.Slice(values[index], func(i, j int) bool {
			left, right := values[index][i], values[index][j]
			if left.Path != right.Path {
				return left.Path < right.Path
			}
			if left.StartLine != right.StartLine {
				return left.StartLine < right.StartLine
			}
			return left.ExcerptID < right.ExcerptID
		})
		if len(values[index]) > maxEvidencePerCategory {
			pruned += len(values[index]) - maxEvidencePerCategory
			values[index] = values[index][:maxEvidencePerCategory]
		}
	}
	return values, pruned
}

type omissionAccumulator struct {
	groups map[string]*omissionGroup
}

func newOmissionAccumulator() *omissionAccumulator {
	return &omissionAccumulator{groups: make(map[string]*omissionGroup)}
}

func (a *omissionAccumulator) add(reason, example string) {
	a.addCount(reason, 1, []string{example})
}

func (a *omissionAccumulator) addCount(reason string, count int, examples []string) {
	if count <= 0 {
		return
	}
	group, ok := a.groups[reason]
	if !ok {
		group = &omissionGroup{Reason: reason, Examples: []string{}}
		a.groups[reason] = group
	}
	group.Count += count
	for _, example := range examples {
		if len([]byte(example)) > maxExamplePathBytes || !safeRepositoryPath(example) || containsString(group.Examples, example) || len(group.Examples) >= maxOmissionExamples {
			continue
		}
		group.Examples = append(group.Examples, example)
	}
	sort.Strings(group.Examples)
}

func (a *omissionAccumulator) total() int {
	total := 0
	for _, group := range a.groups {
		total += group.Count
	}
	return total
}

func (a *omissionAccumulator) values() []omissionGroup {
	keys := make([]string, 0, len(a.groups))
	for key := range a.groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	values := make([]omissionGroup, 0, len(keys))
	for _, key := range keys {
		group := *a.groups[key]
		if group.Examples == nil {
			group.Examples = []string{}
		}
		values = append(values, group)
	}
	return values
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func makePacket(request workerRequest, inventory repositoryInventory, scan scanResult, started time.Time) (researchPacket, error) {
	categories, categoryPruned := scan.store.packetCategories()
	packet := researchPacket{
		Version:            1,
		Target:             packetTarget{Query: request.Query, Root: ".", Repository: inventory.kind},
		Snapshot:           packetSnapshot{ID: inventory.fingerprint, Validated: true, Revision: inventory.revision},
		GoverningArtifacts: categories[0], Definitions: categories[1], Callers: categories[2], Imports: categories[3], Tests: categories[4], Configuration: categories[5], Matches: categories[6],
		Excerpts: append([]excerpt{}, scan.store.excerpts...),
		Unknowns: uniqueStrings(scan.unknowns), Omissions: scan.omissions.values(),
	}
	if packet.Unknowns == nil {
		packet.Unknowns = []string{}
	}
	if len(packet.Unknowns) > maxUnknowns {
		packet.Unknowns = packet.Unknowns[:maxUnknowns]
	}
	packet.Excerpts = sortExcerpts(packet.Excerpts)
	packet = retainReferences(packet)
	addPacketOmission(&packet, "excerpt_limit", categoryPruned)
	if len(packet.Excerpts) > maxExcerpts {
		pruned := len(packet.Excerpts) - maxExcerpts
		packet.Excerpts = packet.Excerpts[:maxExcerpts]
		packet = retainReferences(packet)
		addPacketOmission(&packet, "excerpt_limit", pruned)
	}
	packetID := hashID(inventory.fingerprint + "\x00" + request.Query)
	discoveredFiles := len(inventory.entries)
	if discoveredFiles > maxDiscoveredFiles {
		discoveredFiles = maxDiscoveredFiles
	}
	packet.Receipt = receipt{PacketID: packetID, SchemaVersion: 1, PolicyVersion: policyVersion, SnapshotID: inventory.fingerprint, DurationMS: time.Since(started).Milliseconds(), DiscoveredFiles: discoveredFiles, ReadFiles: scan.readFiles, BytesRead: scan.bytesRead, ExcerptCount: len(packet.Excerpts)}
	packet = fitPacket(packet)
	packet.Receipt.ExcerptCount = len(packet.Excerpts)
	packet.Receipt.OmissionCount = omissionTotal(packet.Omissions)
	if err := validatePacket(packet); err != nil {
		return researchPacket{}, err
	}
	return packet, nil
}

func hashID(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func uniqueStrings(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	out := result[:0]
	for _, value := range result {
		if value != "" && (len(out) == 0 || out[len(out)-1] != value) {
			out = append(out, value)
		}
	}
	return out
}

func sortExcerpts(values []excerpt) []excerpt {
	result := append([]excerpt{}, values...)
	sort.Slice(result, func(i, j int) bool {
		left, right := result[i], result[j]
		if excerptPriority(left.Kind) != excerptPriority(right.Kind) {
			return excerptPriority(left.Kind) < excerptPriority(right.Kind)
		}
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		if left.StartLine != right.StartLine {
			return left.StartLine < right.StartLine
		}
		return left.ID < right.ID
	})
	return result
}

func excerptPriority(kind string) int {
	switch kind {
	case "match":
		return 0
	case "governing":
		return 1
	case "definition":
		return 2
	case "caller":
		return 3
	case "import":
		return 4
	case "test":
		return 5
	case "configuration":
		return 6
	default:
		return 7
	}
}

func retainReferences(packet researchPacket) researchPacket {
	known := make(map[string]struct{}, len(packet.Excerpts))
	for _, item := range packet.Excerpts {
		known[item.ID] = struct{}{}
	}
	filter := func(values []evidenceRef) []evidenceRef {
		result := make([]evidenceRef, 0, len(values))
		for _, value := range values {
			if _, ok := known[value.ExcerptID]; ok {
				result = append(result, value)
			}
		}
		return result
	}
	packet.GoverningArtifacts = filter(packet.GoverningArtifacts)
	packet.Definitions = filter(packet.Definitions)
	packet.Callers = filter(packet.Callers)
	packet.Imports = filter(packet.Imports)
	packet.Tests = filter(packet.Tests)
	packet.Configuration = filter(packet.Configuration)
	packet.Matches = filter(packet.Matches)
	used := make(map[string]struct{})
	for _, category := range [][]evidenceRef{packet.GoverningArtifacts, packet.Definitions, packet.Callers, packet.Imports, packet.Tests, packet.Configuration, packet.Matches} {
		for _, reference := range category {
			used[reference.ExcerptID] = struct{}{}
		}
	}
	excerpts := make([]excerpt, 0, len(packet.Excerpts))
	for _, item := range packet.Excerpts {
		if _, ok := used[item.ID]; ok {
			excerpts = append(excerpts, item)
		}
	}
	packet.Excerpts = excerpts
	return packet
}

func addPacketOmission(packet *researchPacket, reason string, count int) {
	if count <= 0 {
		return
	}
	for index := range packet.Omissions {
		if packet.Omissions[index].Reason == reason {
			packet.Omissions[index].Count += count
			return
		}
	}
	packet.Omissions = append(packet.Omissions, omissionGroup{Reason: reason, Count: count, Examples: []string{}})
	sort.Slice(packet.Omissions, func(i, j int) bool { return packet.Omissions[i].Reason < packet.Omissions[j].Reason })
}

func omissionTotal(values []omissionGroup) int {
	total := 0
	for _, value := range values {
		total += value.Count
	}
	return total
}

func fitPacket(packet researchPacket) researchPacket {
	packet = retainReferences(packet)
	for {
		packet.Receipt.ExcerptCount = len(packet.Excerpts)
		packet.Receipt.OmissionCount = omissionTotal(packet.Omissions)
		encoded, err := json.Marshal(packet)
		if err == nil && len(encoded) <= maxPacketBytes {
			return packet
		}
		if len(packet.Excerpts) == 0 {
			return packet
		}
		packet.Excerpts = packet.Excerpts[:len(packet.Excerpts)-1]
		packet = retainReferences(packet)
		addPacketOmission(&packet, "packet_limit", 1)
	}
}

func gitEnvironment() []string {
	pathValue := os.Getenv("PATH")
	if pathValue == "" {
		pathValue = "/usr/bin:/bin"
	}
	return []string{
		"PATH=" + pathValue,
		"LANG=C",
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_PAGER=cat",
	}
}

type commandResult struct {
	stdout []byte
	stderr []byte
	code   int
}

type pipeResult struct {
	data     []byte
	overflow bool
	err      error
}

var gitStartMutex sync.Mutex

func runGit(repository *openedRepository, args []string, outputLimit int) (commandResult, error) {
	command := exec.Command("git", args...)
	command.Env = gitEnvironment()
	stdout, err := command.StdoutPipe()
	if err != nil {
		return commandResult{}, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return commandResult{}, err
	}
	if err := startInRepository(repository, command); err != nil {
		return commandResult{}, err
	}
	stdoutResult := make(chan pipeResult, 1)
	stderrResult := make(chan pipeResult, 1)
	go readCommandPipe(stdout, outputLimit, stdoutResult, command)
	go readCommandPipe(stderr, maxGitStderrBytes, stderrResult, command)
	out := <-stdoutResult
	errOut := <-stderrResult
	waitErr := command.Wait()
	if out.err != nil {
		return commandResult{}, fmt.Errorf("read git stdout: %w", out.err)
	}
	if errOut.err != nil {
		return commandResult{}, fmt.Errorf("read git stderr: %w", errOut.err)
	}
	if out.overflow || errOut.overflow {
		return commandResult{}, fmt.Errorf("git output exceeded configured limit")
	}
	result := commandResult{stdout: out.data, stderr: errOut.data}
	if waitErr == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		result.code = exitErr.ExitCode()
		return result, nil
	}
	return commandResult{}, fmt.Errorf("wait for git: %w", waitErr)
}

func startInRepository(repository *openedRepository, command *exec.Cmd) error {
	gitStartMutex.Lock()
	defer gitStartMutex.Unlock()
	previous, err := os.Open(".")
	if err != nil {
		return fmt.Errorf("hold current directory: %w", err)
	}
	if err := syscall.Fchdir(int(repository.directory.Fd())); err != nil {
		_ = previous.Close()
		return fmt.Errorf("enter authorized root: %w", err)
	}
	startErr := command.Start()
	restoreErr := syscall.Fchdir(int(previous.Fd()))
	closeErr := previous.Close()
	if startErr != nil {
		return fmt.Errorf("start git: %w", startErr)
	}
	if restoreErr != nil {
		cleanupErr := killAndReap(command)
		if cleanupErr != nil {
			return fmt.Errorf("restore current directory: %v; cleanup git: %w", restoreErr, cleanupErr)
		}
		return fmt.Errorf("restore current directory: %w", restoreErr)
	}
	if closeErr != nil {
		cleanupErr := killAndReap(command)
		if cleanupErr != nil {
			return fmt.Errorf("close previous directory: %v; cleanup git: %w", closeErr, cleanupErr)
		}
		return fmt.Errorf("close previous directory: %w", closeErr)
	}
	return nil
}

func killAndReap(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	killErr := command.Process.Kill()
	waitErr := command.Wait()
	if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
		return fmt.Errorf("kill git: %w", killErr)
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(waitErr, &exitErr) {
			return fmt.Errorf("wait for killed git: %w", waitErr)
		}
	}
	return nil
}

func readCommandPipe(reader io.Reader, limit int, result chan<- pipeResult, command *exec.Cmd) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		result <- pipeResult{err: err}
		return
	}
	if len(data) > limit {
		_ = command.Process.Kill()
		result <- pipeResult{data: data, overflow: true}
		return
	}
	result <- pipeResult{data: data}
}
