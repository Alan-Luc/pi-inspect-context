package inspectcontext

import (
	"fmt"
	"strings"
	"testing"
)

func TestPackageDocumentationRetainsRepositoryFallback(t *testing.T) {
	for _, git := range []bool{false, true} {
		t.Run(fmt.Sprintf("git=%t", git), func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "services/billing/package.json", "{}\n")
			for index := 0; index < minimumPackageSourcePaths; index++ {
				writeWorkerFile(t, root, fmt.Sprintf("services/billing/docs/guide%d.md", index), "Use scoped_needle to create an invoice.\n")
			}
			writeWorkerFile(t, root, "services/invoicing/handler.go", "func scoped_needle() {}\n")
			if git {
				runWorkerGit(t, root, "init", "--quiet")
				runWorkerGit(t, root, "add", "-A")
			}
			packet, err := invokeScopeWorker(t, root, "services/billing", "scoped_needle")
			if err != nil {
				t.Fatal(err)
			}
			if len(packet.Definitions) != 1 || packet.Definitions[0].Path != "services/invoicing/handler.go" {
				t.Fatalf("documentation-only package hid sibling definition: %+v", packet.Definitions)
			}
			if !strings.Contains(strings.Join(packet.Unknowns, "\n"), "fallback") {
				t.Fatalf("missing explicit repository fallback: %v", packet.Unknowns)
			}
		})
	}
}
