package inspectcontext

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestReadingPriorityActivation(t *testing.T) {
	for _, test := range []struct {
		name, query, path, declaration string
		pathOnly                       bool
		promoted                       bool
	}{
		{"symbol", "needle_fn", "src/owner.py", "def needle_fn():", false, true},
		{"unmatched code term", "needle_fn MissingSymbol", "src/owner.py", "def needle_fn():", false, true},
		{"broad", "needle", "src/owner.py", "def needle():", false, false},
		{"mixed", "needle_fn prose", "src/owner.py", "def needle_fn():", false, false},
		{"route", "/needle_fn", "src/owner.py", "route = '/needle_fn'", false, false},
		{"test declaration", "needle_fn", "__tests__/owner.py", "def needle_fn():", false, false},
		{"python test declaration", "needle_fn", "src/test_owner.py", "def needle_fn():", false, false},
		{"configuration declaration", "needle_fn", "config.yaml", "needle_fn = value", false, false},
		{"governing declaration", "needle_fn", "README.md", "def needle_fn():", false, false},
		{"path only", "needle_fn", "src/needle_fn.py", "def needle_fn():", true, false},
		{"no declaration", "needle_fn", "src/owner.py", "needle_fn()", false, false},
		{"empty terms", "", "src/owner.py", "def needle_fn():", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			terms := extractSearchTerms(test.query)
			files := []retrievalFile{
				{path: "tests/consumer.py", lines: []string{"needle_fn()"}},
				{path: test.path, lines: []string{test.declaration}},
			}
			windows := make([]retrievalWindow, len(files))
			for index, file := range files {
				contentTerms := matchingSearchTerms(strings.ToLower(file.lines[0]), terms)
				if test.pathOnly && index == 1 {
					contentTerms = nil
				}
				candidate := retrievalCandidate{path: file.path, fileIndex: index, startLine: 1, endLine: 1, contentTerms: contentTerms}
				windows[index] = retrievalWindow{path: file.path, fileIndex: index, startLine: 1, endLine: 1, candidates: []retrievalCandidate{candidate}}
			}
			original := append([]retrievalWindow{}, windows...)
			got := promoteReadingPriority(windows, files, terms)
			want := original
			if test.promoted {
				want = []retrievalWindow{original[1], original[0]}
			}
			if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(windows, original) {
				t.Fatalf("promotion = %+v, want %+v; original mutated: %t", got, want, !reflect.DeepEqual(windows, original))
			}
		})
	}
}

func TestReadingPriorityStableRoles(t *testing.T) {
	terms := extractSearchTerms("needle_fn")
	files := []retrievalFile{
		{path: "tests/first.py", lines: []string{"needle_fn()"}},
		{path: "src/caller_a.py", lines: []string{"needle_fn()"}},
		{path: "src/owner_a.py", lines: []string{"def needle_fn():"}},
		{path: "src/support.py", lines: []string{"from module import needle_fn"}},
		{path: "src/caller_b.py", lines: []string{"needle_fn()"}},
		{path: "src/owner_b.py", lines: []string{"def needle_fn():"}},
		{path: "settings.yaml", lines: []string{"needle_fn: enabled"}},
	}
	windows := make([]retrievalWindow, len(files))
	for index, file := range files {
		windows[index] = retrievalWindow{path: file.path, fileIndex: index, startLine: 1, endLine: 1, candidates: []retrievalCandidate{{path: file.path, fileIndex: index, startLine: 1, endLine: 1, contentTerms: []int{0}, score: int64(100 - index)}}}
	}
	got := promoteReadingPriority(windows, files, terms)
	want := []retrievalWindow{windows[2], windows[5], windows[1], windows[4], windows[0], windows[3], windows[6]}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("role order = %+v, want %+v", got, want)
	}
	for range 3 {
		if !reflect.DeepEqual(promoteReadingPriority(windows, files, terms), got) {
			t.Fatal("promotion is nondeterministic")
		}
	}
}

func TestReadingPriorityMergedWindowRole(t *testing.T) {
	terms := extractSearchTerms("needle_fn")
	for _, test := range []struct {
		name, path, want string
		matchedLines     []int
	}{
		{"caller before declaration", "src/owner.py", "definition", []int{1, 2}},
		{"declaration before caller", "src/owner.py", "definition", []int{2, 1}},
		{"context declaration is not matched", "src/owner.py", "caller", []int{1}},
		{"test merged declaration", "tests/owner.py", "", []int{1, 2}},
		{"configuration merged declaration", "config.yaml", "", []int{1, 2}},
		{"governing merged declaration", "README.md", "", []int{1, 2}},
	} {
		t.Run(test.name, func(t *testing.T) {
			files := []retrievalFile{{path: test.path, lines: []string{"needle_fn()", "def needle_fn():"}}}
			window := retrievalWindow{path: test.path, startLine: 1, endLine: 2}
			for _, line := range test.matchedLines {
				window.candidates = append(window.candidates, retrievalCandidate{path: test.path, startLine: line, endLine: line, contentTerms: []int{0}})
			}
			if got := readingPriorityRole(window, files, terms); got != test.want {
				t.Fatalf("role = %q, want %q", got, test.want)
			}
		})
	}
}

func TestReadingPriorityOriginalRecallTail(t *testing.T) {
	terms := extractSearchTerms("needle_fn")
	files := []retrievalFile{}
	windows := []retrievalWindow{}
	for index := range 80 {
		path := fmt.Sprintf("tests/support_%02d.py", index)
		line := "needle_fn()"
		if index == 79 {
			path, line = "src/owner.py", "def needle_fn():"
		}
		files = append(files, retrievalFile{path: path, lines: []string{line}})
		windows = append(windows, retrievalWindow{path: path, fileIndex: index, startLine: 1, endLine: 1, candidates: []retrievalCandidate{{path: path, fileIndex: index, startLine: 1, endLine: 1, contentTerms: []int{0}}}})
	}
	primary := selectRetrievalWindows(promoteReadingPriority(windows, files, terms), terms)
	if len(primary) != primaryRetrievalWindowLimit || primary[0].path != "src/owner.py" {
		t.Fatalf("primary selection = %+v", primary)
	}
	complete := completeRetrievalWindows(primary, windows)
	if len(complete) != maxExcerpts {
		t.Fatalf("complete count = %d", len(complete))
	}
	seen := map[retrievalWindowIdentity]bool{}
	for _, window := range primary {
		seen[retrievalWindowIdentity{window.path, window.startLine, window.endLine}] = true
	}
	tail := []retrievalWindow{}
	for _, window := range windows {
		if !seen[retrievalWindowIdentity{window.path, window.startLine, window.endLine}] {
			tail = append(tail, window)
		}
	}
	if !reflect.DeepEqual(complete[len(primary):], tail[:maxExcerpts-len(primary)]) {
		t.Fatal("recall tail changed original lexical order or deduplication")
	}
}

func TestReadingPriorityPacketBudget(t *testing.T) {
	root := t.TempDir()
	for index := range 70 {
		writeWorkerFile(t, root, fmt.Sprintf("tests/call_%02d.py", index), "needle_fn() # "+strings.Repeat("padding", 100)+"\n")
	}
	writeWorkerFile(t, root, "src/owner.py", "def needle_fn():\n    pass\n")
	writeWorkerFile(t, root, "settings.yaml", "needle_fn: enabled\n")
	packet, _, err := invokeWorker(t, root, "needle_fn")
	if err != nil {
		t.Fatal(err)
	}
	if packet.Excerpts[0].Path != "src/owner.py" || len(packet.Configuration) != 1 || len(packet.Tests) == 0 {
		t.Fatal("required definition/configuration/tests displaced")
	}
	if len(packet.Excerpts) >= maxExcerpts || packet.Receipt.ExcerptCount+packet.Receipt.OmissionCount != 72 {
		t.Fatalf("fitting/accounting: %+v", packet.Receipt)
	}
	encoded, err := json.Marshal(packet)
	if err != nil || len(encoded) > targetPacketBytes || len(encoded) > maxPacketBytes {
		t.Fatalf("packet bytes = %d, error = %v", len(encoded), err)
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
	repeated, _, err := invokeWorker(t, root, "needle_fn")
	if err != nil {
		t.Fatal(err)
	}
	packet.Receipt.DurationMS, repeated.Receipt.DurationMS = 0, 0
	if !reflect.DeepEqual(packet, repeated) {
		t.Fatal("packet is nondeterministic under pressure")
	}
}

func TestReadingPriorityPacketPressure(t *testing.T) {
	root := t.TempDir()
	for index := range 36 {
		writeWorkerFile(t, root, fmt.Sprintf("tests/call_%02d.py", index), "needle_fn()\n")
	}
	writeWorkerFile(t, root, "src/deep/owner.py", "def needle_fn():\n    pass\n")
	writeWorkerFile(t, root, "settings.yaml", "needle_fn: enabled\n")
	packet, _, err := invokeWorker(t, root, "needle_fn")
	if err != nil {
		t.Fatal(err)
	}
	if packet.Excerpts[0].Path != "src/deep/owner.py" {
		t.Fatalf("first path = %s", packet.Excerpts[0].Path)
	}
	if len(packet.Excerpts) != 38 || len(packet.Tests) != maxEvidencePerCategory || len(packet.Configuration) != 1 {
		t.Fatalf("lost tests/configuration: excerpts=%d tests=%d configuration=%d", len(packet.Excerpts), len(packet.Tests), len(packet.Configuration))
	}
	if packet.Receipt.OmissionCount != 0 || packet.Receipt.ExcerptCount != 38 {
		t.Fatalf("unexpected accounting: %+v", packet.Receipt)
	}
	encoded, err := json.Marshal(packet)
	if err != nil || len(encoded) > targetPacketBytes {
		t.Fatalf("packet bytes = %d, error = %v", len(encoded), err)
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
}
