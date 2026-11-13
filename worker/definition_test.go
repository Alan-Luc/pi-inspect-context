package inspectcontext

import "testing"

func TestLanguageDefinitionClassification(t *testing.T) {
	for _, test := range []struct {
		name, path, line, query, kind string
	}{
		{"typescript class method", "service.ts", "  async loadAccount(id: string): Promise<Account> {", "loadAccount", "definition"},
		{"typescript object method", "object.ts", "  lookupAccount(id: string) {", "lookupAccount", "definition"},
		{"typescript arrow", "arrow.ts", "export const formatAccount = (id: string) => id;", "formatAccount", "definition"},
		{"go receiver", "service.go", "func (store *Store) FetchEntry(id string) string {", "FetchEntry", "definition"},
		{"python async", "service.py", "async def load_account(account_id):", "load_account", "definition"},
		{"python dataclass field", "model.py", "    account_id: str", "account_id", "definition"},
		{"java method", "Service.java", "    public Account loadAccount(String id) {", "loadAccount", "definition"},
		{"typescript caller", "routes.ts", "  return service.loadAccount(id);", "loadAccount", "caller"},
		{"object caller", "routes.ts", "  lookupAccount(id);", "lookupAccount", "caller"},
		{"go caller", "caller.go", "  store.FetchEntry(id)", "FetchEntry", "caller"},
		{"python caller", "api.py", "  await load_account(account_id)", "load_account", "caller"},
		{"java caller", "Routes.java", "  return service.loadAccount(id);", "loadAccount", "caller"},
		{"call inside control flow", "routes.ts", "  if (loadAccount(id)) {", "loadAccount", "caller"},
	} {
		t.Run(test.name, func(t *testing.T) {
			categories := classifyMatch(test.path, test.line, test.query)
			if len(categories) != 1 || categories[0].kind != test.kind {
				t.Fatalf("classifyMatch(%q, %q, %q) = %+v, want %s", test.path, test.line, test.query, categories, test.kind)
			}
			root := t.TempDir()
			writeWorkerFile(t, root, test.path, test.line+"\n")
			packet, _, err := invokeWorker(t, root, test.query)
			if err != nil {
				t.Fatal(err)
			}
			var references []evidenceRef
			if test.kind == "definition" {
				references = packet.Definitions
			} else {
				references = packet.Callers
			}
			if len(references) != 1 || references[0].Path != test.path || references[0].StartLine != 1 {
				t.Fatalf("packet %s references = %+v, want %s:1", test.kind, references, test.path)
			}
		})
	}
}

func TestWorkerExcludesAgentConfiguration(t *testing.T) {
	for _, git := range []bool{false, true} {
		name := "filesystem"
		if git {
			name = "git"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "source.py", "def needle():\n    pass\n")
			for _, path := range []string{".claude/commands/needle.md", ".cursor/rules/needle.md", "app/.claude/needle.md", "app/.cursor/needle.md"} {
				writeWorkerFile(t, root, path, "needle\n")
			}
			if git {
				runWorkerGit(t, root, "init", "--quiet")
				runWorkerGit(t, root, "add", "-A")
			}
			packet, _, err := invokeWorker(t, root, "needle")
			if err != nil {
				t.Fatal(err)
			}
			for _, excerpt := range packet.Excerpts {
				if excerpt.Path != "source.py" {
					t.Errorf("excluded agent configuration returned: %s", excerpt.Path)
				}
			}
			if len(packet.Definitions) != 1 || packet.Definitions[0].Path != "source.py" {
				t.Fatalf("source definition lost: %+v", packet.Definitions)
			}
		})
	}
}
