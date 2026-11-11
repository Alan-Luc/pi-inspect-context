package inspectcontext

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkerReturnsBoundedBodiesAndCallerEnclosures(t *testing.T) {
	for _, test := range []struct {
		name, path, source, query, kind, required string
		start, end                                int
		complete                                  bool
	}{
		{"go nested braces and literals", "source.go", "func targetFn() {\n  if ready {\n    marker := \"}\"\n    /* } */\n    work()\n  }\n  done()\n}\n", "targetFn", "definition", "done()", 1, 8, true},
		{"typescript member", "source.ts", "class Store {\n  targetFn() {\n    const marker = \"}\";\n    if (ready) {\n      work();\n    }\n    return marker;\n  }\n}\n", "targetFn", "definition", "return marker", 2, 8, true},
		{"typescript arrow body", "source.ts", "export const targetFn = () => {\n  prepare();\n  work();\n  return result;\n};\n", "targetFn", "definition", "return result", 1, 5, true},
		{"typescript multiline arrow", "source.ts", "export const targetFn = async (\n  id: string,\n) => {\n  prepare();\n  return id;\n};\n", "targetFn", "definition", "return id", 1, 6, true},
		{"typescript expression arrow", "source.ts", "export const targetFn = (id: string) => id;\n", "targetFn", "definition", "=> id;", 1, 1, true},
		{"python async indentation and docstring", "source.py", "async def target_fn():\n    note = \"\"\"a brace }\noutside indentation\n    \"\"\"\n    if note:\n        work()\n    return note\n\ndef next_function():\n    pass\n", "target_fn", "definition", "return note", 1, 8, true},
		{"python explicit continuation", "source.py", "def target_fn():\n    total = 1 + \\\n0\n    return total\n", "target_fn", "definition", "return total", 1, 4, true},
		{"python form-feed indentation", "source.py", "class Store:\n    def target_fn():\n        work()\n\f        return 1\n", "target_fn", "definition", "return 1", 2, 4, true},
		{"java method", "Service.java", "class Service {\n  public String targetFn() {\n    String marker = \"}\";\n    prepare();\n    work();\n    return marker;\n  }\n}\n", "targetFn", "definition", "return marker", 2, 7, true},
		{"caller enclosure", "caller.go", "func serve() {\n  prepare()\n  if ready {\n    targetFn()\n  }\n  finish()\n}\n", "targetFn", "caller", "func serve()", 1, 7, true},
		{"truncated definition", "source.go", "func targetFn() {\n" + strings.Repeat("  work()\n", 99) + "}\n", "targetFn", "definition", "func targetFn", 1, 80, false},
		{"deep caller remains partial", "caller.go", "func serve() {\n" + strings.Repeat("  work()\n", 90) + "  targetFn()\n" + strings.Repeat("  work()\n", 10) + "}\n", "targetFn", "caller", "targetFn()", 90, 94, false},
		{"unterminated body", "source.go", "func targetFn() {\n  work()\n", "targetFn", "definition", "work()", 1, 2, false},
		{"unterminated string", "source.go", "func targetFn() {\n  marker := \"}\n  done()\n}\n", "targetFn", "definition", "done()", 1, 4, false},
		{"ambiguous javascript regex", "source.js", "function targetFn() {\n  const pattern = /}/;\n  work();\n  return pattern;\n}\n", "targetFn", "definition", "return pattern", 1, 5, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, test.path, test.source)
			packet, raw, err := invokeWorker(t, root, test.query)
			if err != nil {
				t.Fatal(err)
			}
			var response struct {
				Excerpts []struct {
					Path         string `json:"path"`
					Kind         string `json:"kind"`
					Text         string `json:"text"`
					StartLine    int    `json:"startLine"`
					EndLine      int    `json:"endLine"`
					BodyComplete *bool  `json:"bodyComplete"`
				} `json:"excerpts"`
			}
			if err := json.Unmarshal([]byte(raw), &response); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, excerpt := range response.Excerpts {
				if excerpt.Path != test.path || excerpt.Kind != test.kind {
					continue
				}
				found = true
				if !strings.Contains(excerpt.Text, test.required) || excerpt.StartLine != test.start || excerpt.EndLine != test.end {
					t.Errorf("body range or text = %+v, want %d-%d containing %q", excerpt, test.start, test.end, test.required)
				}
				if excerpt.BodyComplete == nil || *excerpt.BodyComplete != test.complete {
					t.Errorf("bodyComplete = %v, want explicit %t", excerpt.BodyComplete, test.complete)
				}
			}
			if !found {
				t.Fatalf("missing %s excerpt: %+v", test.kind, packet.Excerpts)
			}
		})
	}
}

func TestWorkerUsesKindSpecificContextWindows(t *testing.T) {
	for _, test := range []struct {
		path, matched, kind string
		start, end          int
	}{
		{"source.ts", "import targetFn from './module';", "import", 3, 3},
		{"tests/scenario.ts", "targetFn();", "test", 2, 4},
		{"settings.yaml", "targetFn: enabled", "configuration", 2, 4},
		{"guide.md", "Use targetFn here.", "match", 3, 3},
	} {
		t.Run(test.kind, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, test.path, "before one\nbefore two\n"+test.matched+"\nafter one\nafter two\n")
			packet, _, err := invokeWorker(t, root, "targetFn")
			if err != nil {
				t.Fatal(err)
			}
			if len(packet.Excerpts) != 1 || packet.Excerpts[0].Kind != test.kind || packet.Excerpts[0].StartLine != test.start || packet.Excerpts[0].EndLine != test.end {
				t.Fatalf("%s context = %+v, want %d-%d", test.kind, packet.Excerpts, test.start, test.end)
			}
		})
	}
}
