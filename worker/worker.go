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
	"unicode"
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

	maxSearchTerms                       = 8
	maxGitSearchWorkers                  = 4
	maxGitCleanCandidates                = 64
	maxRetrievalCandidatesFile           = 8
	maxRetrievalCandidateEvaluationsFile = maxRetrievalCandidatesFile * 8
	maxRetrievalCandidates               = maxExcerpts * 4
	maxRetrievalCandidateEvaluations     = maxDiscoveredFiles * (maxRetrievalCandidateEvaluationsFile + maxSearchTerms)
	retrievalContextRadius               = 2
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
	kind          string
	entries       []inventoryEntry
	fingerprint   string
	revision      *string
	worktreePaths map[string]struct{}
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
	var fingerprint string
	var worktreePaths map[string]struct{}
	if kind == "git" {
		entries, fingerprint, worktreePaths, err = collectGitInventory(repository, revision)
	} else {
		entries, err = collectFilesystemInventory(repository)
		fingerprint = inventoryFingerprint(entries)
	}
	if err != nil {
		return repositoryInventory{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	return repositoryInventory{kind: kind, entries: entries, fingerprint: fingerprint, revision: revision, worktreePaths: worktreePaths}, nil
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
	result, err := runGitMetadata(repository, []string{"rev-parse", "--show-toplevel"}, 4096)
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
	revisionResult, err := runGitMetadata(repository, []string{"rev-parse", "--verify", "--quiet", "HEAD"}, 4096)
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

func readAdmittedFile(repository *openedRepository, entry inventoryEntry, result *scanResult) (*retrievalFile, error) {
	expected := entry.info
	if expected == nil {
		var err error
		expected, err = lstatRepositoryPath(repository.root, entry.path)
		if err != nil {
			return nil, fmt.Errorf("%w: inspect %q: %v", errSnapshotChanged, entry.path, err)
		}
		if expected.Mode()&os.ModeSymlink != 0 || !expected.Mode().IsRegular() {
			return nil, fmt.Errorf("%w: file %q is not a regular file", errSnapshotChanged, entry.path)
		}
	}
	if expected.Size() > maxFileBytes {
		result.omissions.add("oversized_file", entry.path)
		return nil, nil
	}
	if result.bytesRead+expected.Size() > maxAggregateReadBytes {
		result.omissions.add("aggregate_byte_limit", entry.path)
		return nil, nil
	}
	data, info, err := readRepositoryFile(repository.root, entry.path, expected)
	if err != nil {
		if errors.Is(err, errSnapshotChanged) {
			return nil, err
		}
		result.omissions.add("read_error", entry.path)
		return nil, nil
	}
	result.readFiles++
	result.bytesRead += int64(len(data))
	result.accepted[entry.path] = fingerprintFor(entry.path, info)
	if bytes.IndexByte(data, 0) >= 0 {
		result.omissions.add("binary_file", entry.path)
		return nil, nil
	}
	if !utf8.Valid(data) {
		result.omissions.add("invalid_utf8", entry.path)
		return nil, nil
	}
	text := string(data)
	return &retrievalFile{path: entry.path, text: text, lines: sourceLines(text)}, nil
}

func appendAdmittedFile(repository *openedRepository, entry inventoryEntry, result *scanResult, files *[]retrievalFile) error {
	result.discoveredFiles++
	file, err := readAdmittedFile(repository, entry, result)
	if err != nil {
		return err
	}
	if file != nil {
		*files = append(*files, *file)
	}
	return nil
}

func scanInventory(repository *openedRepository, query string, inventory repositoryInventory) (scanResult, error) {
	result := scanResult{
		store:     newEvidenceStore(),
		omissions: newOmissionAccumulator(),
		accepted:  make(map[string]fileFingerprint),
	}
	terms := extractSearchTerms(query)
	if len(terms) == 0 {
		return scanResult{}, errors.New("query has no searchable terms")
	}
	eligible := make([]inventoryEntry, 0, len(inventory.entries))
	entriesByPath := make(map[string]inventoryEntry, len(inventory.entries))
	for _, entry := range inventory.entries {
		entriesByPath[entry.path] = entry
		if entry.excluded != "" {
			result.omissions.add(entry.excluded, entry.path)
			continue
		}
		eligible = append(eligible, entry)
	}
	files := make([]retrievalFile, 0, maxDiscoveredFiles)
	if inventory.kind == "git" && !termsContainNonASCII(terms) {
		worktree := make([]inventoryEntry, 0, len(inventory.worktreePaths))
		for path := range inventory.worktreePaths {
			entry, ok := entriesByPath[path]
			if ok && entry.excluded == "" {
				worktree = append(worktree, entry)
			}
		}
		sort.Slice(worktree, func(left, right int) bool {
			leftTerms := matchingPathTerms(strings.ToLower(worktree[left].path), terms)
			rightTerms := matchingPathTerms(strings.ToLower(worktree[right].path), terms)
			if (len(leftTerms) > 0) != (len(rightTerms) > 0) {
				return len(leftTerms) > 0
			}
			return worktree[left].path < worktree[right].path
		})
		worktreeContent := make(map[string][]int, len(worktree))
		for _, entry := range worktree {
			if result.discoveredFiles >= maxDiscoveredFiles {
				result.omissions.add("file_limit", entry.path)
				continue
			}
			if err := appendAdmittedFile(repository, entry, &result, &files); err != nil {
				return scanResult{}, err
			}
			for _, file := range files {
				if file.path == entry.path {
					worktreeContent[entry.path] = matchingSearchTerms(strings.ToLower(file.text), terms)
					break
				}
			}
		}
		contentByPath := make(map[string][]int)
		inventoryPaths := make(map[string]struct{}, len(entriesByPath))
		for path := range entriesByPath {
			inventoryPaths[path] = struct{}{}
		}
		type gitSearchOutcome struct {
			paths []string
			err   error
		}
		searchOutcomes := make([]gitSearchOutcome, len(terms))
		searchJobs := make(chan int)
		var searchWait sync.WaitGroup
		searchWorkers := minInt(maxGitSearchWorkers, len(terms))
		for range searchWorkers {
			searchWait.Add(1)
			go func() {
				defer searchWait.Done()
				for termIndex := range searchJobs {
					term := terms[termIndex]
					grepResult, grepErr := runGitInput(repository, []string{"grep", "--cached", "-F", "-i", "-I", "-l", "-z", "-f", "-", "--"}, term.original+"\n", maxGitOutputBytes)
					if grepErr != nil {
						searchOutcomes[termIndex].err = fmt.Errorf("git grep term %q: %w", term.original, grepErr)
						continue
					}
					if grepResult.code == 1 {
						continue
					}
					if grepResult.code != 0 {
						searchOutcomes[termIndex].err = fmt.Errorf("git grep term %q failed with exit code %d: %s", term.original, grepResult.code, strings.TrimSpace(string(grepResult.stderr)))
						continue
					}
					matches, parseErr := parseGitMatchPaths(grepResult.stdout, inventoryPaths)
					if parseErr != nil {
						searchOutcomes[termIndex].err = parseErr
						continue
					}
					searchOutcomes[termIndex].paths = matches
				}
			}()
		}
		for termIndex := range terms {
			searchJobs <- termIndex
		}
		close(searchJobs)
		searchWait.Wait()
		for termIndex, outcome := range searchOutcomes {
			if outcome.err != nil {
				return scanResult{}, outcome.err
			}
			for _, path := range outcome.paths {
				if _, dirty := inventory.worktreePaths[path]; dirty {
					continue
				}
				entry := entriesByPath[path]
				if entry.excluded == "" {
					contentByPath[path] = append(contentByPath[path], termIndex)
				}
			}
		}
		candidates := make([]gitCandidate, 0, len(eligible))
		for _, entry := range eligible {
			if _, dirty := inventory.worktreePaths[entry.path]; dirty {
				continue
			}
			contentTerms := normalizeTermIndexes(contentByPath[entry.path])
			pathTerms := matchingPathTerms(strings.ToLower(entry.path), terms)
			if len(contentTerms) > 0 || len(pathTerms) > 0 {
				candidates = append(candidates, gitCandidate{path: entry.path, contentTerms: contentTerms, pathTerms: pathTerms})
			}
		}
		allCandidates := append([]gitCandidate{}, candidates...)
		for _, entry := range worktree {
			allCandidates = append(allCandidates, gitCandidate{path: entry.path, contentTerms: worktreeContent[entry.path], pathTerms: matchingPathTerms(strings.ToLower(entry.path), terms)})
		}
		frequencies := make([]int, len(terms))
		for _, candidate := range allCandidates {
			for _, termIndex := range gitCandidateTerms(candidate) {
				if termIndex >= 0 && termIndex < len(frequencies) {
					frequencies[termIndex]++
				}
			}
		}
		ordered := orderGitCandidates(candidates, query, terms, frequencies, len(candidates))
		remaining := maxDiscoveredFiles - result.discoveredFiles
		if remaining < 0 {
			remaining = 0
		}
		if remaining > maxGitCleanCandidates {
			remaining = maxGitCleanCandidates
		}
		for index, candidate := range ordered {
			if index >= remaining {
				result.omissions.add("file_limit", candidate.path)
				continue
			}
			if err := appendAdmittedFile(repository, entriesByPath[candidate.path], &result, &files); err != nil {
				return scanResult{}, err
			}
		}
	} else {
		ordered := append([]inventoryEntry{}, eligible...)
		if inventory.kind == "git" {
			sort.Slice(ordered, func(left, right int) bool {
				leftDirty := false
				_, leftDirty = inventory.worktreePaths[ordered[left].path]
				rightDirty := false
				_, rightDirty = inventory.worktreePaths[ordered[right].path]
				if leftDirty != rightDirty {
					return leftDirty
				}
				return ordered[left].path < ordered[right].path
			})
		} else {
			sort.Slice(ordered, func(left, right int) bool { return ordered[left].path < ordered[right].path })
		}
		for index, entry := range ordered {
			if index >= maxDiscoveredFiles {
				result.omissions.add("file_limit", entry.path)
				continue
			}
			if err := appendAdmittedFile(repository, entry, &result, &files); err != nil {
				return scanResult{}, err
			}
		}
	}

	collection := collectRetrievalCandidates(files, query, terms)
	windows := buildRetrievalWindows(files, collection.candidates)
	exactRepresented, fallbackRepresented := addRetrievalEvidence(&result, files, terms, windows)
	result.omissions.addCount("excerpt_limit", collection.exactObserved-exactRepresented, nil)
	result.omissions.addCount("excerpt_limit", collection.fallbackObserved-fallbackRepresented, nil)
	if len(result.store.excerpts) == 0 {
		result.unknowns = append(result.unknowns, "No lexical matches; retry with an exact symbol, route, config key, or path fragment.")
	} else {
		result.unknowns = append(result.unknowns, "Definitions, callers, and imports are lexical candidates rather than a semantic call graph.")
		if result.ambiguous {
			result.unknowns = append(result.unknowns, "Some matches fit more than one lexical heuristic; inspect surrounding code.")
		}
	}
	if result.omissions.total() > 0 {
		result.unknowns = append(result.unknowns, "Some files or evidence were omitted by bounded scanning; zero results do not prove absence.")
	}
	return result, nil
}

func termsContainNonASCII(terms []searchTerm) bool {
	for _, term := range terms {
		if strings.IndexFunc(term.original, func(value rune) bool { return value >= utf8.RuneSelf }) >= 0 {
			return true
		}
	}
	return false
}

var queryStopWords = map[string]struct{}{
	"a": {}, "an": {}, "and": {}, "are": {}, "as": {}, "at": {}, "be": {}, "by": {}, "for": {}, "from": {},
	"how": {}, "in": {}, "is": {}, "it": {}, "its": {}, "of": {}, "on": {}, "or": {}, "that": {}, "the": {},
	"this": {}, "through": {}, "to": {}, "under": {}, "what": {}, "where": {}, "which": {}, "with": {},
}

func extractSearchTerms(query string) []searchTerm {
	terms := make([]searchTerm, 0, maxSearchTerms)
	current := make([]rune, 0, len(query))
	var fallback *searchTerm
	flush := func() {
		if len(current) == 0 {
			return
		}
		original := string(current)
		current = current[:0]
		lower := strings.ToLower(original)
		if !strings.ContainsFunc(original, func(value rune) bool {
			return value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value)
		}) {
			return
		}
		codeLike := strings.HasPrefix(original, "/") || strings.Contains(original, "_")
		for _, value := range original {
			if unicode.IsUpper(value) || unicode.IsNumber(value) {
				codeLike = true
				break
			}
		}
		term := searchTerm{original: original, lower: lower, codeLike: codeLike}
		if _, ignored := queryStopWords[lower]; ignored {
			if fallback == nil {
				fallback = &term
			}
			return
		}
		for _, existing := range terms {
			if existing.lower == lower {
				return
			}
		}
		if len(terms) < maxSearchTerms {
			terms = append(terms, term)
		}
	}
	for _, value := range query {
		if value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value) {
			current = append(current, value)
			continue
		}
		if value == '/' {
			if len(current) == 0 || current[0] == '/' {
				current = append(current, value)
			} else {
				flush()
				current = append(current, value)
			}
			continue
		}
		if len(current) > 0 && current[0] == '/' && (value == ':' || value == '-' || value == '.') {
			current = append(current, value)
			continue
		}
		flush()
	}
	flush()
	if len(terms) == 0 && fallback != nil {
		terms = append(terms, *fallback)
	}
	return terms
}

func containsSearchTerm(lowerValue string, term searchTerm) bool {
	if !strings.HasPrefix(term.lower, "/") {
		return strings.Contains(lowerValue, term.lower)
	}
	for offset := strings.Index(lowerValue, term.lower); offset >= 0; {
		if offset == 0 {
			return true
		}
		previous, _ := utf8.DecodeLastRuneInString(lowerValue[:offset])
		if previous != '_' && previous != '/' && previous != '.' && previous != ':' && previous != '-' && !unicode.IsLetter(previous) && !unicode.IsNumber(previous) {
			return true
		}
		next := offset + 1
		if next >= len(lowerValue) {
			break
		}
		relative := strings.Index(lowerValue[next:], term.lower)
		if relative < 0 {
			break
		}
		offset = next + relative
	}
	return false
}

func matchingSearchTerms(lowerValue string, terms []searchTerm) []int {
	matches := make([]int, 0, len(terms))
	for index, term := range terms {
		if containsSearchTerm(lowerValue, term) {
			matches = append(matches, index)
		}
	}
	return matches
}

func matchingPathTerms(lowerPath string, terms []searchTerm) []int {
	matches := make([]int, 0, len(terms))
	for index, term := range terms {
		if strings.Contains(lowerPath, term.lower) {
			matches = append(matches, index)
		}
	}
	return matches
}

func containsTermIndex(values []int, wanted int) bool {
	index := sort.SearchInts(values, wanted)
	return index < len(values) && values[index] == wanted
}

func mergeTermIndexes(left, right []int) []int {
	merged := make([]int, 0, len(left)+len(right))
	leftIndex, rightIndex := 0, 0
	for leftIndex < len(left) || rightIndex < len(right) {
		if rightIndex >= len(right) || (leftIndex < len(left) && left[leftIndex] < right[rightIndex]) {
			if len(merged) == 0 || merged[len(merged)-1] != left[leftIndex] {
				merged = append(merged, left[leftIndex])
			}
			leftIndex++
			continue
		}
		if leftIndex >= len(left) || right[rightIndex] < left[leftIndex] {
			if len(merged) == 0 || merged[len(merged)-1] != right[rightIndex] {
				merged = append(merged, right[rightIndex])
			}
			rightIndex++
			continue
		}
		if len(merged) == 0 || merged[len(merged)-1] != left[leftIndex] {
			merged = append(merged, left[leftIndex])
		}
		leftIndex++
		rightIndex++
	}
	return merged
}

func scoreRetrievalCandidate(candidate retrievalCandidate, terms []searchTerm, frequencies []int, maxFrequency int) int64 {
	matchedTerms := mergeTermIndexes(candidate.contentTerms, candidate.pathTerms)
	score := int64(len(matchedTerms))*1_000_000 + int64(len(candidate.contextTerms))*400_000
	for _, index := range matchedTerms {
		rarity := maxFrequency - frequencies[index] + 1
		if rarity < 1 {
			rarity = 1
		}
		score += int64(rarity) * 1_000
		if terms[index].codeLike && containsTermIndex(candidate.contentTerms, index) {
			score += 1_500_000
		}
	}
	score += int64(len(candidate.pathTerms)) * 250_000
	if len(candidate.contentTerms) > 0 {
		score += 25_000
	}
	if candidate.exact {
		score += 1_000_000_000_000
	}
	return score
}

func retrievalCandidateBefore(left, right retrievalCandidate) bool {
	if left.score != right.score {
		return left.score > right.score
	}
	if left.path != right.path {
		leftDepth := strings.Count(left.path, "/")
		rightDepth := strings.Count(right.path, "/")
		if leftDepth != rightDepth {
			return leftDepth < rightDepth
		}
		return left.path < right.path
	}
	if left.startLine != right.startLine {
		return left.startLine < right.startLine
	}
	if left.endLine != right.endLine {
		return left.endLine < right.endLine
	}
	if left.exact != right.exact {
		return left.exact
	}
	return left.fileIndex < right.fileIndex
}

func addRetrievalCandidate(candidates *[]retrievalCandidate, candidate retrievalCandidate, terms []searchTerm, frequencies []int, maxFrequency int) {
	for index := range *candidates {
		current := &(*candidates)[index]
		if current.startLine != candidate.startLine || current.endLine != candidate.endLine {
			continue
		}
		current.exact = current.exact || candidate.exact
		current.contentTerms = mergeTermIndexes(current.contentTerms, candidate.contentTerms)
		current.pathTerms = mergeTermIndexes(current.pathTerms, candidate.pathTerms)
		current.contextTerms = mergeTermIndexes(current.contextTerms, candidate.contextTerms)
		current.score = scoreRetrievalCandidate(*current, terms, frequencies, maxFrequency)
		return
	}
	candidate.contentTerms = append([]int(nil), candidate.contentTerms...)
	candidate.pathTerms = append([]int(nil), candidate.pathTerms...)
	candidate.contextTerms = append([]int(nil), candidate.contextTerms...)
	candidate.score = scoreRetrievalCandidate(candidate, terms, frequencies, maxFrequency)
	*candidates = append(*candidates, candidate)
	sort.Slice(*candidates, func(i, j int) bool { return retrievalCandidateBefore((*candidates)[i], (*candidates)[j]) })
	if len(*candidates) > maxRetrievalCandidatesFile {
		*candidates = prioritizeCandidateCoverage(*candidates, terms, frequencies, false)[:maxRetrievalCandidatesFile]
	}
}

func nearbySearchTerms(file retrievalFile, startLine, endLine int, terms []searchTerm) []int {
	startLine = maxInt(1, startLine-retrievalContextRadius)
	endLine = minInt(len(file.lines), endLine+retrievalContextRadius)
	if startLine > endLine {
		return []int{}
	}
	return matchingSearchTerms(strings.ToLower(strings.Join(file.lines[startLine-1:endLine], "")), terms)
}

func prioritizeCandidateCoverage(candidates []retrievalCandidate, terms []searchTerm, frequencies []int, includeRareTerms bool) []retrievalCandidate {
	prioritized := make([]retrievalCandidate, 0, len(candidates))
	selected := make([]bool, len(candidates))
	coveredTerms := make([]bool, len(terms))
	markCovered := func(candidate retrievalCandidate) {
		for _, termIndex := range mergeTermIndexes(candidate.contentTerms, candidate.pathTerms) {
			coveredTerms[termIndex] = true
		}
	}
	for index, candidate := range candidates {
		if candidate.exact {
			prioritized = append(prioritized, candidate)
			selected[index] = true
			markCovered(candidate)
		}
	}
	termIndexes := make([]int, 0, len(terms))
	maxFrequency := 0
	for _, frequency := range frequencies {
		maxFrequency = maxInt(maxFrequency, frequency)
	}
	for index, term := range terms {
		if frequencies[index] > 0 && (term.codeLike || includeRareTerms && frequencies[index] < maxFrequency) {
			termIndexes = append(termIndexes, index)
		}
	}
	sort.SliceStable(termIndexes, func(left, right int) bool {
		leftIndex, rightIndex := termIndexes[left], termIndexes[right]
		if frequencies[leftIndex] != frequencies[rightIndex] {
			return frequencies[leftIndex] < frequencies[rightIndex]
		}
		if terms[leftIndex].codeLike != terms[rightIndex].codeLike {
			return terms[leftIndex].codeLike
		}
		return leftIndex < rightIndex
	})
	for _, termIndex := range termIndexes {
		if coveredTerms[termIndex] {
			continue
		}
		for candidateIndex, candidate := range candidates {
			if selected[candidateIndex] || candidate.exact {
				continue
			}
			matchedTerms := mergeTermIndexes(candidate.contentTerms, candidate.pathTerms)
			if containsTermIndex(matchedTerms, termIndex) {
				prioritized = append(prioritized, candidate)
				selected[candidateIndex] = true
				markCovered(candidate)
				break
			}
		}
	}
	for index, candidate := range candidates {
		if !selected[index] {
			prioritized = append(prioritized, candidate)
		}
	}
	return prioritized
}

func collectRetrievalCandidates(files []retrievalFile, query string, terms []searchTerm) retrievalCollection {
	frequencies := make([]int, len(terms))
	for _, file := range files {
		lowerPath := strings.ToLower(file.path)
		lowerText := strings.ToLower(file.text)
		matched := mergeTermIndexes(matchingSearchTerms(lowerText, terms), matchingPathTerms(lowerPath, terms))
		for _, index := range matched {
			frequencies[index]++
		}
	}
	maxFrequency := 0
	for _, frequency := range frequencies {
		if frequency > maxFrequency {
			maxFrequency = frequency
		}
	}
	collection := retrievalCollection{candidates: make([]retrievalCandidate, 0, maxRetrievalCandidates)}
	for fileIndex, file := range files {
		fileCandidates := make([]retrievalCandidate, 0, maxRetrievalCandidatesFile)
		fileEvaluations := 0
		evaluatedTerms := make([]bool, len(terms))
		shouldEvaluate := func(termIndexes []int) bool {
			if collection.evaluatedCandidates < maxRetrievalCandidateEvaluations && fileEvaluations < maxRetrievalCandidateEvaluationsFile {
				return true
			}
			for _, termIndex := range termIndexes {
				if !evaluatedTerms[termIndex] {
					return true
				}
			}
			return false
		}
		markEvaluated := func(termIndexes []int) {
			collection.evaluatedCandidates++
			fileEvaluations++
			for _, termIndex := range termIndexes {
				evaluatedTerms[termIndex] = true
			}
		}
		lowerPath := strings.ToLower(file.path)
		pathTerms := matchingPathTerms(lowerPath, terms)
		boundedExactFound := false
		forEachLiteralMatch(file.text, query, func(match literalMatch) {
			collection.exactObserved++
			if match.endLine-match.startLine+1 > maxExcerptLines {
				return
			}
			boundedExactFound = true
			contentTerms := matchingSearchTerms(strings.ToLower(match.text), terms)
			if !shouldEvaluate(contentTerms) {
				return
			}
			markEvaluated(contentTerms)
			addRetrievalCandidate(&fileCandidates, retrievalCandidate{
				fileIndex: fileIndex, path: file.path, startLine: match.startLine, endLine: match.endLine,
				exact: true, contentTerms: contentTerms,
				contextTerms: nearbySearchTerms(file, match.startLine, match.endLine, terms),
			}, terms, frequencies, maxFrequency)
		})
		if boundedExactFound {
			collection.candidates = append(collection.candidates, fileCandidates...)
			continue
		}
		for lineIndex, line := range file.lines {
			contentTerms := matchingSearchTerms(strings.ToLower(line), terms)
			if len(contentTerms) == 0 {
				continue
			}
			collection.fallbackObserved++
			directTerms := mergeTermIndexes(contentTerms, pathTerms)
			if !shouldEvaluate(directTerms) {
				continue
			}
			markEvaluated(directTerms)
			addRetrievalCandidate(&fileCandidates, retrievalCandidate{
				fileIndex: fileIndex, path: file.path, startLine: lineIndex + 1, endLine: lineIndex + 1,
				contentTerms: contentTerms, pathTerms: pathTerms,
				contextTerms: nearbySearchTerms(file, lineIndex+1, lineIndex+1, terms),
			}, terms, frequencies, maxFrequency)
		}
		if len(pathTerms) > 0 && len(file.lines) > 0 && len(matchingSearchTerms(strings.ToLower(file.lines[0]), terms)) == 0 {
			collection.fallbackObserved++
			if shouldEvaluate(pathTerms) {
				markEvaluated(pathTerms)
				addRetrievalCandidate(&fileCandidates, retrievalCandidate{
					fileIndex: fileIndex, path: file.path, startLine: 1, endLine: 1, pathTerms: pathTerms,
					contextTerms: nearbySearchTerms(file, 1, 1, terms),
				}, terms, frequencies, maxFrequency)
			}
		}
		collection.candidates = append(collection.candidates, fileCandidates...)
	}
	sort.Slice(collection.candidates, func(i, j int) bool {
		return retrievalCandidateBefore(collection.candidates[i], collection.candidates[j])
	})
	collection.candidates = prioritizeCandidateCoverage(collection.candidates, terms, frequencies, true)
	if len(collection.candidates) > maxRetrievalCandidates {
		collection.candidates = collection.candidates[:maxRetrievalCandidates]
	}
	return collection
}

func retrievalWindowBounds(candidate retrievalCandidate, lineCount int) (int, int) {
	startLine, endLine := candidate.startLine, candidate.endLine
	if !candidate.exact {
		startLine -= retrievalContextRadius
		endLine += retrievalContextRadius
	}
	if startLine < 1 {
		startLine = 1
	}
	if endLine > lineCount {
		endLine = lineCount
	}
	return startLine, endLine
}

func retrievalWindowsOverlap(left, right retrievalWindow) bool {
	return left.path == right.path && left.startLine <= right.endLine && right.startLine <= left.endLine
}

func buildRetrievalWindows(files []retrievalFile, candidates []retrievalCandidate) []retrievalWindow {
	windows := make([]retrievalWindow, 0, maxExcerpts)
	for _, candidate := range candidates {
		lines := files[candidate.fileIndex].lines
		if len(lines) == 0 {
			continue
		}
		startLine, endLine := retrievalWindowBounds(candidate, len(lines))
		incoming := retrievalWindow{fileIndex: candidate.fileIndex, path: candidate.path, startLine: startLine, endLine: endLine, candidates: []retrievalCandidate{candidate}}
		overlaps := make(map[int]struct{})
		for {
			previousCount := len(overlaps)
			probe := retrievalWindow{path: incoming.path, startLine: incoming.startLine, endLine: incoming.endLine}
			for index := range windows {
				if _, found := overlaps[index]; found || !retrievalWindowsOverlap(probe, windows[index]) {
					continue
				}
				overlaps[index] = struct{}{}
				incoming.startLine = minInt(incoming.startLine, windows[index].startLine)
				incoming.endLine = maxInt(incoming.endLine, windows[index].endLine)
			}
			if len(overlaps) == previousCount {
				break
			}
		}
		if len(overlaps) == 0 {
			if len(windows) < maxExcerpts {
				windows = append(windows, incoming)
			}
			continue
		}
		if incoming.endLine-incoming.startLine+1 > maxExcerptLines {
			continue
		}
		for index := range windows {
			if _, found := overlaps[index]; found {
				incoming.candidates = append(incoming.candidates, windows[index].candidates...)
			}
		}
		merged := make([]retrievalWindow, 0, len(windows)-len(overlaps)+1)
		inserted := false
		for index, window := range windows {
			if _, found := overlaps[index]; !found {
				merged = append(merged, window)
				continue
			}
			if !inserted {
				merged = append(merged, incoming)
				inserted = true
			}
		}
		windows = merged
	}
	for index := range windows {
		sort.Slice(windows[index].candidates, func(left, right int) bool {
			return retrievalCandidateBefore(windows[index].candidates[left], windows[index].candidates[right])
		})
	}
	return windows
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func retrievalWindowText(file retrievalFile, window retrievalWindow) string {
	return strings.Join(file.lines[window.startLine-1:window.endLine], "")
}

func appendUniqueCategory(categories []matchCategory, candidate matchCategory) []matchCategory {
	for _, category := range categories {
		if category.kind == candidate.kind {
			return categories
		}
	}
	return append(categories, candidate)
}

func classifyRetrievedCandidate(path, line string, candidate retrievalCandidate, terms []searchTerm) []matchCategory {
	categories := make([]matchCategory, 0, 3)
	if governingName(path) {
		categories = append(categories, matchCategory{kind: "governing", confidence: "observed", reason: "query-relevant governing artifact"})
	}
	if isTestPath(path) {
		return appendUniqueCategory(categories, matchCategory{kind: "test", confidence: "observed", reason: "test path match"})
	}
	if isConfigurationPath(path) {
		return appendUniqueCategory(categories, matchCategory{kind: "configuration", confidence: "observed", reason: "configuration path match"})
	}
	for _, index := range candidate.contentTerms {
		for _, category := range classifyMatch(path, strings.TrimSuffix(line, "\n"), terms[index].original) {
			categories = appendUniqueCategory(categories, category)
		}
	}
	return categories
}

func primaryMatchCategory(categories []matchCategory) (matchCategory, bool) {
	for _, kind := range []string{"governing", "test", "configuration", "definition", "caller", "import"} {
		for _, category := range categories {
			if category.kind == kind {
				return category, true
			}
		}
	}
	return matchCategory{}, false
}

func addRetrievalEvidence(result *scanResult, files []retrievalFile, terms []searchTerm, windows []retrievalWindow) (int, int) {
	exactRepresented, fallbackRepresented := 0, 0
	for rank, window := range windows {
		result.store.setRank(rank)
		text := retrievalWindowText(files[window.fileIndex], window)
		if text == "" {
			continue
		}
		categories := make([]matchCategory, 0, 3)
		for _, candidate := range window.candidates {
			line := ""
			if candidate.startLine >= 1 && candidate.startLine <= len(files[candidate.fileIndex].lines) {
				line = files[candidate.fileIndex].lines[candidate.startLine-1]
			}
			for _, category := range classifyRetrievedCandidate(candidate.path, line, candidate, terms) {
				categories = appendUniqueCategory(categories, category)
			}
		}
		if len(categories) > 1 {
			result.ambiguous = true
		}
		primary, categorized := primaryMatchCategory(categories)
		if !categorized {
			top := window.candidates[0]
			reason := "lexical match"
			if top.exact {
				reason = "literal match"
			} else if len(top.contentTerms) == 0 {
				reason = "path match"
			}
			primary = matchCategory{kind: "match", confidence: "observed", reason: reason}
		}
		matched := result.store.add(primary.kind, window.path, window.startLine, window.endLine, text, primary.confidence, primary.reason)
		if !matched && primary.kind != "match" {
			matched = result.store.add("match", window.path, window.startLine, window.endLine, text, "observed", "lexical match")
		}
		if matched {
			for _, candidate := range window.candidates {
				if candidate.exact {
					exactRepresented++
				} else {
					fallbackRepresented++
				}
			}
		}
	}
	return exactRepresented, fallbackRepresented
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
	lowerLine := strings.ToLower(line)
	lowerQuery := strings.ToLower(query)
	trimmed := strings.TrimSpace(lowerLine)
	for _, keyword := range []string{"func ", "function ", "class ", "interface ", "struct ", "type ", "const ", "let ", "var ", "def ", "fn ", "export function ", "export class "} {
		if strings.Contains(trimmed, keyword+lowerQuery) {
			return true
		}
	}
	index := strings.Index(lowerLine, lowerQuery)
	if index < 0 {
		return false
	}
	rest := strings.TrimSpace(lowerLine[index+len(lowerQuery):])
	return strings.HasPrefix(rest, ":=") || strings.HasPrefix(rest, "=")
}

func isCallLine(line, query string) bool {
	lowerLine := strings.ToLower(line)
	lowerQuery := strings.ToLower(query)
	index := strings.Index(lowerLine, lowerQuery)
	if index < 0 {
		return false
	}
	rest := strings.TrimSpace(lowerLine[index+len(lowerQuery):])
	return strings.HasPrefix(rest, "(")
}

type evidenceStore struct {
	excerpts      []excerpt
	categories    map[string][]evidenceRef
	seen          map[string]string
	referenceSeen map[string]struct{}
	excerptRanks  map[string]int
	rank          int
}

func newEvidenceStore() *evidenceStore {
	return &evidenceStore{excerpts: make([]excerpt, 0), categories: map[string][]evidenceRef{
		"governing": {}, "definition": {}, "caller": {}, "import": {}, "test": {}, "configuration": {}, "match": {},
	}, seen: make(map[string]string), referenceSeen: make(map[string]struct{}), excerptRanks: make(map[string]int)}
}

func (s *evidenceStore) setRank(rank int) {
	s.rank = rank
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
		s.excerptRanks[id] = s.rank
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
			leftRank, rightRank := s.excerptRanks[left.ExcerptID], s.excerptRanks[right.ExcerptID]
			if leftRank != rightRank {
				return leftRank < rightRank
			}
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
	packet.Excerpts = sortExcerptsWithRanks(packet.Excerpts, scan.store.excerptRanks)
	packet = retainReferences(packet)
	addPacketOmission(&packet, "excerpt_limit", categoryPruned)
	if len(packet.Excerpts) > maxExcerpts {
		pruned := len(packet.Excerpts) - maxExcerpts
		packet.Excerpts = packet.Excerpts[:maxExcerpts]
		packet = retainReferences(packet)
		addPacketOmission(&packet, "excerpt_limit", pruned)
	}
	packetID := hashID(inventory.fingerprint + "\x00" + request.Query)
	packet.Receipt = receipt{PacketID: packetID, SchemaVersion: 1, PolicyVersion: policyVersion, SnapshotID: inventory.fingerprint, DurationMS: time.Since(started).Milliseconds(), DiscoveredFiles: scan.discoveredFiles, ReadFiles: scan.readFiles, BytesRead: scan.bytesRead, ExcerptCount: len(packet.Excerpts)}
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

func sortExcerptsWithRanks(values []excerpt, ranks map[string]int) []excerpt {
	result := append([]excerpt{}, values...)
	sort.SliceStable(result, func(i, j int) bool {
		leftRank, rightRank := ranks[result[i].ID], ranks[result[j].ID]
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return excerptBefore(result[i], result[j])
	})
	return result
}

func sortExcerpts(values []excerpt) []excerpt {
	result := append([]excerpt{}, values...)
	sort.Slice(result, func(i, j int) bool {
		left, right := result[i], result[j]
		return excerptBefore(left, right)
	})
	return result
}

func excerptBefore(left, right excerpt) bool {
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
	return runGitInput(repository, args, "", outputLimit)
}

func runGitMetadata(repository *openedRepository, args []string, outputLimit int) (commandResult, error) {
	return runGitCommand(repository, args, "", outputLimit)
}

func runGitInput(repository *openedRepository, args []string, input string, outputLimit int) (commandResult, error) {
	return runGitCommand(repository, args, input, outputLimit)
}

func runGitCommand(repository *openedRepository, args []string, input string, outputLimit int) (commandResult, error) {
	args = append([]string{"-c", "core.fsmonitor=false"}, args...)
	command := exec.Command("git", args...)
	command.Env = gitEnvironment()
	command.Stdin = strings.NewReader(input)
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
