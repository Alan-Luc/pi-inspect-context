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
		{"javascript regex helper does not enclose caller", "caller.js", "export function serve() {\n  function helper() {\n    return /[{]/.test(input);\n  }\n  targetFn();\n}\nafterServe();\n", "targetFn", "caller", "targetFn()", 3, 7, false},
		{"javascript inline regex helper does not enclose caller", "caller.js", "function serve() {\n  function hasBrace(s) { return /{/.test(s); }\n  targetFn();\n}\n", "targetFn", "caller", "function serve", 1, 4, false},
		{"javascript normal CRLF remains complete", "source.js", "function targetFn() {\r\n  work();\r\n}\r\n", "targetFn", "definition", "work()", 1, 3, true},
		{"go nested braces and literals", "source.go", "func targetFn() {\n  if ready {\n    marker := \"}\"\n    /* } */\n    work()\n  }\n  done()\n}\n", "targetFn", "definition", "done()", 1, 8, true},
		{"typescript member", "source.ts", "class Store {\n  targetFn() {\n    const marker = \"}\";\n    if (ready) {\n      work();\n    }\n    return marker;\n  }\n}\n", "targetFn", "definition", "return marker", 2, 8, true},
		{"javascript caller skips control blocks", "caller.js", "function serve() {\n  prepare();\n  if (ready) {\n    targetFn();\n  }\n  finish();\n}\n", "targetFn", "caller", "finish()", 1, 7, true},
		{"nested arrow conditional stays partial", "source.js", "export const targetFn = () =>\n  ready ? () => {\n    work();\n  } :\n    runFallback();\n", "targetFn", "definition", "runFallback()", 1, 5, false},
		{"arrow conditional expression stays partial", "source.js", "export const targetFn = () =>\n  ready\n    ? { value: 1 }\n    : runFallback();\n", "targetFn", "definition", "runFallback()", 1, 4, false},
		{"typescript generic object return stays partial", "source.ts", "export async function targetFn(): Promise<{\n  value: string;\n}> {\n  await audit();\n  return { value: 'ok' };\n}\n", "targetFn", "definition", "await audit()", 1, 6, false},
		{"typescript inline object return stays partial", "source.ts", "export async function targetFn(): Promise<{ user: User }> {\n  const user = await fetchUser();\n  audit(user);\n  return { user };\n}\n", "targetFn", "definition", "audit(user)", 1, 5, false},
		{"typescript generic constraint stays partial", "source.ts", "class TargetFn<T extends { id: string }> {\n  value = 1;\n  get() { return this.value; }\n}\n", "TargetFn", "definition", "value = 1", 1, 3, false},
		{"typescript intersection return stays partial", "source.ts", "export function targetFn(): Foo & { a: 1 } {\n  work();\n  return value;\n}\n", "targetFn", "definition", "work()", 1, 4, false},
		{"java caller skips else if", "Service.java", "class Service {\n  void serve() {\n    if (ready) { prepare(); }\n    else if (retry) {\n      targetFn();\n    }\n    finish();\n  }\n}\n", "targetFn", "caller", "void serve()", 2, 8, true},
		{"java caller skips anonymous initializer", "Service.java", "class Service {\n  void serve() {\n    prepare();\n    new Foo() {\n      { targetFn(); }\n    };\n    finish();\n  }\n}\n", "targetFn", "caller", "finish()", 2, 8, true},
		{"jsx apostrophe stays partial", "Banner.tsx", "export function targetFn() {\n  if (x) return <p>Don't</p>;\n  if (y) {\n    // it's hidden\n    reset();\n  }\n  hidden();\n  return null;\n}\n", "targetFn", "definition", "hidden();", 1, 9, false},
		{"python reused fstring quotes stay partial", "source.py", "def target_fn():\n    text = f\"{\"\"\"\nunindented text\n\"\"\"}\"\n    return text\n", "target_fn", "definition", "return text", 1, 5, false},
		{"typescript parenthesized intersection stays partial", "source.ts", "export function targetFn(): (Foo) & { a: 1 } {\n  audit();\n  return value;\n}\n", "targetFn", "definition", "audit()", 1, 4, false},
		{"typescript keyof return stays partial", "source.ts", "export function targetFn(): keyof {\n  value: string;\n}\n{\n  audit();\n  return 'value';\n}\n", "targetFn", "definition", "audit()", 1, 7, false},
		{"typescript conditional alias stays partial", "source.ts", "export type TargetFn = Ready extends Yes\n  ? { value: string }\n  : { fallback: boolean };\n", "TargetFn", "definition", "fallback: boolean", 1, 3, false},
		{"javascript inline base class stays partial", "source.js", "class TargetFn extends class {\n  base() {}\n} {\n  hidden() {}\n}\n", "TargetFn", "definition", "class TargetFn", 1, 3, false},
		{"typescript arrow body", "source.ts", "export const targetFn = () => {\n  prepare();\n  work();\n  return result;\n};\n", "targetFn", "definition", "return result", 1, 5, true},
		{"typescript multiline arrow", "source.ts", "export const targetFn = async (\n  id: string,\n) => {\n  prepare();\n  return id;\n};\n", "targetFn", "definition", "return id", 1, 6, true},
		{"typescript expression arrow caller", "caller.ts", "export const serve = (id: string) =>\n  targetFn(id);\n", "targetFn", "caller", "const serve", 1, 2, true},
		{"typescript expression arrow", "source.ts", "export const targetFn = (id: string) => id;\n", "targetFn", "definition", "=> id;", 1, 1, true},
		{"python async indentation and docstring", "source.py", "async def target_fn():\n    note = \"\"\"a brace }\noutside indentation\n    \"\"\"\n    if note:\n        work()\n    return note\n\ndef next_function():\n    pass\n", "target_fn", "definition", "return note", 1, 8, true},
		{"python explicit continuation", "source.py", "def target_fn():\n    total = 1 + \\\n0\n    return total\n", "target_fn", "definition", "return total", 1, 4, true},
		{"python form-feed indentation", "source.py", "class Store:\n    def target_fn():\n        work()\n\f        return 1\n", "target_fn", "definition", "return 1", 2, 4, true},
		{"java caller skips returned anonymous initializer", "Service.java", "class Service {\n  Foo serve() {\n    prepare();\n    return new Foo() {\n      { targetFn(); }\n    };\n  }\n}\n", "targetFn", "caller", "prepare()", 2, 7, true},
		{"java unicode escapes stay partial", "Service.java", "class Service {\n  void targetFn() {\n    if (ready) \\u007b\n      work();\n    }\n    hidden();\n  }\n}\n", "targetFn", "definition", "hidden();", 2, 8, false},
		{"javascript carriage return stays partial", "source.js", "function targetFn() {\n  // comment\r  if (ready) {\n    work();\n  }\n  hidden();\n}\n", "targetFn", "definition", "hidden();", 1, 6, false},
		{"javascript line separator stays partial", "source.js", "function targetFn() {\n  // comment\u2028  if (ready) {\n    work();\n  }\n  hidden();\n}\n", "targetFn", "definition", "hidden();", 1, 6, false},
		{"java internal carriage return stays partial", "Service.java", "class Service {\n  void targetFn() {\n    // comment\r    if (ready) {\n      work();\n    }\n    hidden();\n  }\n}\n", "targetFn", "definition", "hidden();", 2, 8, false},
		{"python internal carriage return stays partial", "source.py", "def target_fn():\n    prepare()\n    # comment\r    text = \"\"\"hello\noutdented text\n\"\"\"\n    hidden()\n", "target_fn", "definition", "hidden()", 1, 6, false},
		{"jsx same line quote closure stays partial", "Banner.tsx", "export function targetFn() {\n  if (x) return <p>Don't</p>; if (y) { // it's hidden\n    work();\n  }\n  hidden();\n}\n", "targetFn", "definition", "hidden();", 1, 6, false},
		{"javascript legacy close comment stays partial", "source.js", "function targetFn() {\n  --> comment }\n  hidden();\n}\n", "targetFn", "definition", "hidden();", 1, 4, false},
		{"javascript closed helper is not caller", "caller.js", "export function serve(items) {\n  function isBig(x) { return x > 10; }\n  targetFn(items.filter(isBig));\n}\n", "targetFn", "caller", "function serve", 1, 4, false},
		{"python closed helper is not caller", "source.py", "def serve():\n    def label(x):\n        return f\"{x}\"\n    target_fn()\n", "target_fn", "caller", "target_fn()", 2, 4, false},
		{"typescript alias does not enclose caller", "caller.ts", "export type Handler = (id: string) => void;\napp.get('/health', (req, res) => {\n  targetFn();\n});\n" + strings.Repeat("void 0;\n", 90), "targetFn", "caller", "targetFn()", 1, 5, false},
		{"typescript alias keeps default window", "source.ts", "export type Handler = (id: string) => void;\napp.get('/health', (req, res) => {\n  targetFn();\n});\n" + strings.Repeat("void 0;\n", 90), "Handler", "definition", "type Handler", 1, 3, false},
		{"python template quotes stay partial", "source.py", "def target_fn():\n    text = t\"{\"\"\"\nunindented text\n\"\"\"}\"\n    return text\n", "target_fn", "definition", "return text", 1, 5, false},
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
