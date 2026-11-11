package inspectcontext

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

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

func collectGitInventory(repository *openedRepository, revision *string) ([]inventoryEntry, string, map[string]struct{}, error) {
	inventoryArgs := []string{"ls-files", "--cached", "--others", "--exclude-standard", "-z"}
	inventoryResult, err := runGit(repository, inventoryArgs, maxGitOutputBytes)
	if err != nil {
		return nil, "", nil, err
	}
	if len(inventoryResult.stdout) == 0 && len(inventoryResult.stderr) == 0 && inventoryResult.code == 0 {
		legacyResult, legacyErr := runGitMetadata(repository, inventoryArgs, maxGitOutputBytes)
		if legacyErr != nil {
			return nil, "", nil, legacyErr
		}
		if legacyResult.code != 0 || len(legacyResult.stdout) > 0 || len(legacyResult.stderr) > 0 {
			inventoryResult = legacyResult
		}
	}
	if inventoryResult.code != 0 {
		return nil, "", nil, fmt.Errorf("git inventory failed: %s", strings.TrimSpace(string(inventoryResult.stderr)))
	}
	paths, err := parseGitPaths(inventoryResult.stdout)
	if err != nil {
		return nil, "", nil, err
	}
	entries := make([]inventoryEntry, 0, len(paths))
	entryIndexes := make(map[string]int, len(paths))
	for _, path := range paths {
		if _, exists := entryIndexes[path]; exists {
			return nil, "", nil, fmt.Errorf("git inventory contains duplicate path %q", path)
		}
		entryIndexes[path] = len(entries)
		entries = append(entries, inventoryEntry{path: path, excluded: exclusionReason(path)})
	}
	inventoryPaths := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		inventoryPaths[entry.path] = struct{}{}
	}

	statusResult, err := runGit(repository, []string{"status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"}, maxGitOutputBytes)
	if err != nil {
		return nil, "", nil, err
	}
	if statusResult.code != 0 {
		return nil, "", nil, fmt.Errorf("git status failed with exit code %d: %s", statusResult.code, strings.TrimSpace(string(statusResult.stderr)))
	}
	statusPaths, err := parseGitStatusPaths(statusResult.stdout, inventoryPaths)
	if err != nil {
		return nil, "", nil, err
	}
	worktreePaths := make(map[string]struct{}, len(statusPaths))
	for _, path := range statusPaths {
		worktreePaths[path] = struct{}{}
		index := entryIndexes[path]
		info, lstatErr := lstatRepositoryPath(repository.root, path)
		if errors.Is(lstatErr, fs.ErrNotExist) {
			if entries[index].excluded == "" {
				entries[index].excluded = "ineligible_file"
			}
			continue
		}
		if lstatErr != nil {
			return nil, "", nil, lstatErr
		}
		entries[index].info = info
		if entries[index].excluded != "" {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, "", nil, fmt.Errorf("candidate path %q is a symlink", path)
		}
		if !info.Mode().IsRegular() {
			return nil, "", nil, fmt.Errorf("candidate path %q is not a regular file", path)
		}
	}
	return entries, gitInventoryFingerprint(revision, inventoryResult.stdout, statusResult.stdout, entries), worktreePaths, nil
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
		if strings.HasSuffix(value, "/") {
			directory := strings.TrimSuffix(value, "/")
			if len([]byte(value)) <= maxPathBytes && safeRepositoryPath(directory) && exclusionReasonForDirectory(directory) != "" {
				continue
			}
		}
		if !safeRepositoryPath(value) {
			return nil, fmt.Errorf("git inventory contains unsafe path %q", value)
		}
		paths = append(paths, value)
	}
	return paths, nil
}

func parseGitMatchPaths(data []byte, inventory map[string]struct{}) ([]string, error) {
	if len(data) == 0 {
		return []string{}, nil
	}
	if data[len(data)-1] != 0 {
		return nil, errors.New("git match output is not NUL terminated")
	}
	parts := bytes.Split(data[:len(data)-1], []byte{0})
	paths := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		path := string(part)
		if !safeRepositoryPath(path) {
			return nil, fmt.Errorf("git match output contains unsafe path %q", path)
		}
		if _, ok := inventory[path]; !ok {
			return nil, fmt.Errorf("git match output contains unknown path %q", path)
		}
		if _, duplicate := seen[path]; duplicate {
			return nil, fmt.Errorf("git match output contains duplicate path %q", path)
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	return paths, nil
}

func parseGitStatusPaths(data []byte, inventory map[string]struct{}) ([]string, error) {
	if len(data) == 0 {
		return []string{}, nil
	}
	if data[len(data)-1] != 0 {
		return nil, errors.New("git status output is not NUL terminated")
	}
	parts := bytes.Split(data[:len(data)-1], []byte{0})
	paths := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		record := string(part)
		var path string
		switch {
		case strings.HasPrefix(record, "1 "):
			fields := strings.SplitN(record, " ", 9)
			if len(fields) != 9 || !validGitStatusXY(fields[1], false) || !validGitSubmoduleState(fields[2]) ||
				!validGitMode(fields[3]) || !validGitMode(fields[4]) || !validGitMode(fields[5]) ||
				!validGitObjectID(fields[6]) || !validGitObjectID(fields[7]) || fields[8] == "" {
				return nil, fmt.Errorf("malformed Git ordinary status record %q", record)
			}
			path = fields[8]
		case strings.HasPrefix(record, "u "):
			fields := strings.SplitN(record, " ", 11)
			if len(fields) != 11 || !validGitStatusXY(fields[1], true) || !validGitSubmoduleState(fields[2]) ||
				!validGitMode(fields[3]) || !validGitMode(fields[4]) || !validGitMode(fields[5]) || !validGitMode(fields[6]) ||
				!validGitObjectID(fields[7]) || !validGitObjectID(fields[8]) || !validGitObjectID(fields[9]) || fields[10] == "" {
				return nil, fmt.Errorf("malformed Git unmerged status record %q", record)
			}
			path = fields[10]
		case strings.HasPrefix(record, "? "):
			fields := strings.SplitN(record, " ", 2)
			if len(fields) != 2 || fields[1] == "" {
				return nil, fmt.Errorf("malformed Git untracked status record %q", record)
			}
			path = fields[1]
		default:
			return nil, fmt.Errorf("unsupported Git status record %q", record)
		}
		if strings.HasSuffix(path, "/") {
			directory := strings.TrimSuffix(path, "/")
			if len([]byte(path)) <= maxPathBytes && safeRepositoryPath(directory) && exclusionReasonForDirectory(directory) != "" {
				continue
			}
		}
		if !safeRepositoryPath(path) {
			return nil, fmt.Errorf("Git status contains unsafe path %q", path)
		}
		if _, ok := inventory[path]; !ok {
			return nil, fmt.Errorf("Git status contains unknown path %q", path)
		}
		if _, duplicate := seen[path]; duplicate {
			return nil, fmt.Errorf("Git status contains duplicate path %q", path)
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	return paths, nil
}

func validGitStatusXY(value string, unmerged bool) bool {
	if unmerged {
		switch value {
		case "DD", "AU", "UD", "UA", "DU", "AA", "UU":
			return true
		default:
			return false
		}
	}
	if len(value) != 2 || value == ".." {
		return false
	}
	for index := range len(value) {
		if !strings.ContainsRune(".MTAD", rune(value[index])) {
			return false
		}
	}
	return true
}

func validGitSubmoduleState(value string) bool {
	return value == "N..." || len(value) == 4 && value[0] == 'S' &&
		(value[1] == '.' || value[1] == 'C') &&
		(value[2] == '.' || value[2] == 'M') &&
		(value[3] == '.' || value[3] == 'U')
}

func validGitMode(value string) bool {
	switch value {
	case "000000", "040000", "100644", "100755", "120000", "160000":
		return true
	default:
		return false
	}
}

func validGitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for index := range len(value) {
		if (value[index] < '0' || value[index] > '9') && (value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
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
		".git": {}, ".harness": {}, ".opencode": {}, ".pi": {}, ".claude": {}, ".cursor": {}, "node_modules": {}, "vendor": {}, "third_party": {}, "deps": {}, "Pods": {},
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

func gitInventoryFingerprint(revision *string, inventory, status []byte, entries []inventoryEntry) string {
	hash := sha256.New()
	if revision == nil {
		_, _ = hash.Write([]byte("unborn\x00"))
	} else {
		fmt.Fprintf(hash, "HEAD\x00%s\x00", *revision)
	}
	fmt.Fprintf(hash, "inventory\x00%d\x00", len(inventory))
	_, _ = hash.Write(inventory)
	fmt.Fprintf(hash, "status\x00%d\x00", len(status))
	_, _ = hash.Write(status)
	for _, entry := range entries {
		if entry.info == nil {
			fmt.Fprintf(hash, "worktree\x00%s\x00missing\x00%s\x00", entry.path, entry.excluded)
			continue
		}
		fingerprint := fingerprintFor(entry.path, entry.info)
		fmt.Fprintf(hash, "worktree\x00%s\x00%d\x00%d\x00%d\x00%s\x00", fingerprint.path, fingerprint.mode, fingerprint.size, fingerprint.modTime, entry.excluded)
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
	store           *evidenceStore
	unknowns        []string
	omissions       *omissionAccumulator
	accepted        map[string]fileFingerprint
	discoveredFiles int
	readFiles       int
	bytesRead       int64
	ambiguous       bool
}

type searchTerm struct {
	original string
	lower    string
	codeLike bool
}

type retrievalFile struct {
	path  string
	text  string
	lines []string
}

type retrievalCandidate struct {
	fileIndex    int
	path         string
	startLine    int
	endLine      int
	exact        bool
	contentTerms []int
	pathTerms    []int
	contextTerms []int
	score        int64
}

type retrievalCollection struct {
	candidates          []retrievalCandidate
	exactObserved       int
	fallbackObserved    int
	evaluatedCandidates int
}

type retrievalWindow struct {
	fileIndex  int
	path       string
	startLine  int
	endLine    int
	candidates []retrievalCandidate
}

func retrievalWindowContentTerms(window retrievalWindow) []int {
	indexes := []int{}
	for _, candidate := range window.candidates {
		indexes = mergeTermIndexes(indexes, candidate.contentTerms)
	}
	return indexes
}

func prioritizeRetrievalWindows(windows []retrievalWindow, terms []searchTerm) []retrievalWindow {
	if len(windows) <= maxRetrievalWindowsFile {
		return windows
	}
	selected := make([]bool, len(windows))
	coveredTerms := make([]bool, len(terms))
	selectedCount := 0
	selectWindow := func(index int) {
		if selected[index] || selectedCount >= maxRetrievalWindowsFile {
			return
		}
		selected[index] = true
		selectedCount++
		for _, termIndex := range retrievalWindowContentTerms(windows[index]) {
			coveredTerms[termIndex] = true
		}
	}
	for index, window := range windows {
		for _, candidate := range window.candidates {
			if candidate.exact {
				selectWindow(index)
				break
			}
		}
	}
	for termIndex, term := range terms {
		if !term.codeLike || coveredTerms[termIndex] || selectedCount >= maxRetrievalWindowsFile {
			continue
		}
		for index, window := range windows {
			if !selected[index] && containsTermIndex(retrievalWindowContentTerms(window), termIndex) {
				selectWindow(index)
				break
			}
		}
	}
	for selectedCount < maxRetrievalWindowsFile {
		bestIndex, bestGain := -1, -1
		for index, window := range windows {
			if selected[index] {
				continue
			}
			gain := 0
			for _, termIndex := range retrievalWindowContentTerms(window) {
				if !coveredTerms[termIndex] {
					gain++
				}
			}
			if gain > bestGain {
				bestIndex, bestGain = index, gain
			}
		}
		if bestIndex < 0 {
			break
		}
		selectWindow(bestIndex)
	}
	result := make([]retrievalWindow, 0, maxRetrievalWindowsFile)
	for index, window := range windows {
		if selected[index] {
			result = append(result, window)
		}
	}
	return result
}

func readingPriorityRole(window retrievalWindow, files []retrievalFile, terms []searchTerm) string {
	if isTestPath(window.path) || isConfigurationPath(window.path) || governingName(window.path) {
		return ""
	}
	role := ""
	for _, candidate := range window.candidates {
		line := ""
		if candidate.startLine >= 1 && candidate.startLine <= len(files[candidate.fileIndex].lines) {
			line = files[candidate.fileIndex].lines[candidate.startLine-1]
		}
		for _, category := range classifyRetrievedCandidate(candidate.path, line, candidate, terms) {
			if category.kind == "definition" {
				return "definition"
			}
			if category.kind == "caller" {
				role = "caller"
			}
		}
	}
	return role
}

func promoteReadingPriority(windows []retrievalWindow, files []retrievalFile, terms []searchTerm) []retrievalWindow {
	if len(terms) == 0 {
		return windows
	}
	for _, term := range terms {
		if !term.codeLike || strings.HasPrefix(term.original, "/") {
			return windows
		}
	}
	var definitions, callers, supporting []retrievalWindow
	for _, window := range windows {
		switch readingPriorityRole(window, files, terms) {
		case "definition":
			definitions = append(definitions, window)
		case "caller":
			callers = append(callers, window)
		default:
			supporting = append(supporting, window)
		}
	}
	if len(definitions) == 0 {
		return windows
	}
	result := make([]retrievalWindow, 0, len(windows))
	result = append(result, definitions...)
	result = append(result, callers...)
	return append(result, supporting...)
}

func selectRetrievalWindows(windows []retrievalWindow, terms []searchTerm) []retrievalWindow {
	byPath := make(map[string][]retrievalWindow)
	for _, window := range windows {
		byPath[window.path] = append(byPath[window.path], window)
	}
	result := make([]retrievalWindow, 0, minInt(len(windows), primaryRetrievalWindowLimit))
	emitted := make(map[string]struct{})
	for _, window := range windows {
		if _, found := emitted[window.path]; found {
			continue
		}
		result = append(result, prioritizeRetrievalWindows(byPath[window.path], terms)...)
		emitted[window.path] = struct{}{}
	}
	if len(result) > primaryRetrievalWindowLimit {
		result = result[:primaryRetrievalWindowLimit]
	}
	return result
}

type retrievalWindowIdentity struct {
	path               string
	startLine, endLine int
}

func completeRetrievalWindows(primary, ranked []retrievalWindow) []retrievalWindow {
	result := append([]retrievalWindow{}, primary...)
	selected := make(map[retrievalWindowIdentity]struct{}, len(primary))
	for _, window := range primary {
		selected[retrievalWindowIdentity{path: window.path, startLine: window.startLine, endLine: window.endLine}] = struct{}{}
	}
	for _, window := range ranked {
		if len(result) >= maxExcerpts {
			break
		}
		identity := retrievalWindowIdentity{path: window.path, startLine: window.startLine, endLine: window.endLine}
		if _, found := selected[identity]; found {
			continue
		}
		result = append(result, window)
		selected[identity] = struct{}{}
	}
	return result
}

type gitCandidate struct {
	path         string
	contentTerms []int
	pathTerms    []int
}

func normalizeTermIndexes(values []int) []int {
	result := append([]int(nil), values...)
	sort.Ints(result)
	return uniqueInts(result)
}

func uniqueInts(values []int) []int {
	if len(values) < 2 {
		return values
	}
	out := values[:1]
	for _, value := range values[1:] {
		if value != out[len(out)-1] {
			out = append(out, value)
		}
	}
	return out
}

func gitCandidateTerms(candidate gitCandidate) []int {
	return mergeTermIndexes(normalizeTermIndexes(candidate.contentTerms), normalizeTermIndexes(candidate.pathTerms))
}

func gitCandidateRarity(candidate gitCandidate, frequencies []int, maxFrequency int) int {
	rarity := 0
	for _, index := range gitCandidateTerms(candidate) {
		if index >= 0 && index < len(frequencies) && frequencies[index] > 0 {
			rarity += maxFrequency - frequencies[index] + 1
		}
	}
	return rarity
}

func orderGitCandidates(candidates []gitCandidate, query string, terms []searchTerm, frequencies []int, limit int) []gitCandidate {
	byPath := make(map[string]gitCandidate, len(candidates))
	for _, candidate := range candidates {
		candidate.contentTerms = normalizeTermIndexes(candidate.contentTerms)
		candidate.pathTerms = normalizeTermIndexes(candidate.pathTerms)
		if current, exists := byPath[candidate.path]; exists {
			current.contentTerms = mergeTermIndexes(current.contentTerms, candidate.contentTerms)
			current.pathTerms = mergeTermIndexes(current.pathTerms, candidate.pathTerms)
			byPath[candidate.path] = current
		} else {
			byPath[candidate.path] = candidate
		}
	}
	base := make([]gitCandidate, 0, len(byPath))
	for _, candidate := range byPath {
		base = append(base, candidate)
	}
	maxFrequency := 0
	for _, frequency := range frequencies {
		maxFrequency = maxInt(maxFrequency, frequency)
	}
	sort.Slice(base, func(left, right int) bool {
		first, second := base[left], base[right]
		firstExact := strings.Contains(first.path, query)
		secondExact := strings.Contains(second.path, query)
		if firstExact != secondExact {
			return firstExact
		}
		if len(first.contentTerms) != len(second.contentTerms) {
			return len(first.contentTerms) > len(second.contentTerms)
		}
		firstCodeTerms := 0
		secondCodeTerms := 0
		for _, index := range first.contentTerms {
			if index >= 0 && index < len(terms) && terms[index].codeLike {
				firstCodeTerms++
			}
		}
		for _, index := range second.contentTerms {
			if index >= 0 && index < len(terms) && terms[index].codeLike {
				secondCodeTerms++
			}
		}
		if firstCodeTerms != secondCodeTerms {
			return firstCodeTerms > secondCodeTerms
		}
		if len(first.pathTerms) != len(second.pathTerms) {
			return len(first.pathTerms) > len(second.pathTerms)
		}
		firstRarity := gitCandidateRarity(first, frequencies, maxFrequency)
		secondRarity := gitCandidateRarity(second, frequencies, maxFrequency)
		if firstRarity != secondRarity {
			return firstRarity > secondRarity
		}
		return first.path < second.path
	})
	if limit < 0 {
		limit = 0
	}
	reserved := make([]gitCandidate, 0, len(base))
	selected := make([]bool, len(base))
	covered := make([]bool, len(terms))
	markCovered := func(candidate gitCandidate) {
		for _, index := range gitCandidateTerms(candidate) {
			if index >= 0 && index < len(covered) {
				covered[index] = true
			}
		}
	}
	for index, candidate := range base {
		if strings.Contains(candidate.path, query) {
			reserved = append(reserved, candidate)
			selected[index] = true
			markCovered(candidate)
		}
	}
	coverageTerms := make([]int, 0, len(terms))
	for index, term := range terms {
		if index < len(frequencies) && frequencies[index] > 0 && (term.codeLike || frequencies[index] < maxFrequency) {
			coverageTerms = append(coverageTerms, index)
		}
	}
	sort.SliceStable(coverageTerms, func(left, right int) bool {
		first, second := coverageTerms[left], coverageTerms[right]
		if frequencies[first] != frequencies[second] {
			return frequencies[first] < frequencies[second]
		}
		if terms[first].codeLike != terms[second].codeLike {
			return terms[first].codeLike
		}
		return first < second
	})
	for _, termIndex := range coverageTerms {
		if covered[termIndex] {
			continue
		}
		for index, candidate := range base {
			if selected[index] || !containsTermIndex(gitCandidateTerms(candidate), termIndex) {
				continue
			}
			reserved = append(reserved, candidate)
			selected[index] = true
			markCovered(candidate)
			break
		}
	}
	for index, candidate := range base {
		if !selected[index] {
			reserved = append(reserved, candidate)
		}
	}
	if limit < len(reserved) {
		reserved = reserved[:limit]
	}
	return reserved
}
