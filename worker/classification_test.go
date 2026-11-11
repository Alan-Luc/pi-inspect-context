package inspectcontext

import "testing"

func TestTestPathClassification(t *testing.T) {
	for _, test := range []struct {
		path string
		want bool
	}{
		{"__tests__/feature.py", true},
		{"src/__tests__/feature.ts", true},
		{"src/__TESTS__/feature.py", true},
		{"test_feature.py", true},
		{"src/test_feature.py", true},
		{"feature_test.py", true},
		{"src/feature_test.py", true},
		{"integration_tests/test_feature.py", true},
		{"src/TEST_FEATURE.PY", true},
		{"test/feature.py", true},
		{"src/test/feature.py", true},
		{"tests/feature.py", true},
		{"src/tests/feature.py", true},
		{"src/feature_test.go", true},
		{"src/feature.test.ts", true},
		{"src/feature.spec.ts", true},
		{"feature_tests/scenario.py", true},
		{"src/feature_tests/scenario.py", true},
		{"integration-tests/account.ts", true},
		{"src/integration-tests/account.ts", true},
		{"src/integration_tests/scenario.py", true},
		{"src/feature.py", false},
		{"src/test_feature.ts", false},
		{"src/test_feature.py.txt", false},
		{"src/feature_test.py.txt", false},
		{"src/test_helpers/feature.py", false},
		{"src/__tests__helpers/feature.py", false},
		{"src/my__tests__/feature.py", false},
		{"src/feature_tests.py", false},
		{"src/latest_feature.py", false},
		{"src/feature_tests_helpers/scenario.py", false},
		{"src/integration-tests-helper/account.ts", false},
	} {
		t.Run(test.path, func(t *testing.T) {
			if got := isTestPath(test.path); got != test.want {
				t.Fatalf("isTestPath(%q) = %t, want %t", test.path, got, test.want)
			}
			categories := classifyMatch(test.path, "needle()", "needle")
			wantKind := "caller"
			if test.want {
				wantKind = "test"
			}
			if len(categories) != 1 || categories[0].kind != wantKind {
				t.Fatalf("classifyMatch(%q) = %+v, want %s", test.path, categories, wantKind)
			}
		})
	}
}

func TestWorkerTestPathClassification(t *testing.T) {
	for _, test := range []struct {
		name  string
		query string
	}{
		{"literal", "needle"},
		{"tokenized", "needle related"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			writeWorkerFile(t, root, "src/feature.py", "def needle():\n    pass\n")
			writeWorkerFile(t, root, "src/caller.py", "needle()\n")
			testPaths := []string{
				"__tests__/feature.py",
				"src/__tests__/test_feature.py",
				"src/test_feature.py",
				"src/feature_test.py",
				"integration_tests/test_feature.py",
				"feature_tests/scenario.py",
				"src/integration-tests/scenario.ts",
			}
			for _, path := range testPaths {
				writeWorkerFile(t, root, path, "from feature import needle\nneedle()\n")
			}

			packet, _, err := invokeWorker(t, root, test.query)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range testPaths {
				found := false
				for _, reference := range packet.Tests {
					if reference.Path == path {
						found = true
					}
				}
				if !found {
					t.Errorf("missing test reference for %s", path)
				}
				for _, excerpt := range packet.Excerpts {
					if excerpt.Path == path && excerpt.Kind != "test" {
						t.Errorf("test excerpt classified as %s: %+v", excerpt.Kind, excerpt)
					}
				}
			}
			if len(packet.Definitions) != 1 || packet.Definitions[0].Path != "src/feature.py" {
				t.Errorf("production definitions = %+v", packet.Definitions)
			}
			if len(packet.Callers) != 1 || packet.Callers[0].Path != "src/caller.py" {
				t.Errorf("production callers = %+v", packet.Callers)
			}
		})
	}
}
