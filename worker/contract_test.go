package inspectcontext

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	value, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "protocol", name))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestProtocolGoldens(t *testing.T) {
	var request workerRequest
	if err := decodeStrict(fixture(t, "request.json"), &request); err != nil {
		t.Fatal(err)
	}
	if err := validateRequest(request); err != nil {
		t.Fatal(err)
	}

	var manifest authorizationManifest
	if err := decodeStrict(fixture(t, "manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	if err := validateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	if request.Root != manifest.Root {
		t.Fatal("request root is not authorized by manifest")
	}

	packetBytes := fixture(t, "packet.json")
	var packet researchPacket
	if err := decodeStrict(packetBytes, &packet); err != nil {
		t.Fatal(err)
	}
	if err := validatePacket(packet); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(packet)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != strings.TrimSpace(string(packetBytes)) {
		t.Fatalf("Go packet serialization drifted from golden\nwant: %s\n got: %s", strings.TrimSpace(string(packetBytes)), encoded)
	}
}

func TestStrictRequestValidation(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"unknown field", `{"version":1,"root":"/tmp/repository","query":"needle","extra":true}`},
		{"trailing value", `{"version":1,"root":"/tmp/repository","query":"needle"} {}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var request workerRequest
			if err := decodeStrict([]byte(test.input), &request); err == nil {
				t.Fatal("expected strict decode failure")
			}
		})
	}

	for _, query := range []string{"/health/ready", "cache refresh startup", "_"} {
		if err := validateQuery(query); err != nil {
			t.Fatalf("searchable query %q was rejected: %v", query, err)
		}
	}

	for _, request := range []workerRequest{
		{Version: 1, Root: "relative", Query: "needle"},
		{Version: 1, Root: "/tmp/repository", Query: ""},
		{Version: 1, Root: "/tmp/repository", Query: "   "},
		{Version: 1, Root: "/tmp/repository", Query: "///***"},
		{Version: 1, Root: "/tmp/repository", Query: strings.Repeat("é", maxQueryBytes/2+1)},
		{Version: 2, Root: "/tmp/repository", Query: "needle"},
	} {
		if err := validateRequest(request); err == nil {
			t.Fatalf("expected validation failure for %#v", request)
		}
	}
}

func TestPacketRejectsBrokenReferencesAndUnsafePaths(t *testing.T) {
	var packet researchPacket
	if err := decodeStrict(fixture(t, "packet.json"), &packet); err != nil {
		t.Fatal(err)
	}

	brokenReference := packet
	brokenReference.Matches = append([]evidenceRef(nil), packet.Matches...)
	brokenReference.Matches[0].ExcerptID = "missing"
	if err := validatePacket(brokenReference); err == nil {
		t.Fatal("expected broken reference failure")
	}

	unsafePath := packet
	unsafePath.Excerpts = append([]excerpt(nil), packet.Excerpts...)
	unsafePath.Excerpts[0].Path = "../outside"
	if err := validatePacket(unsafePath); err == nil {
		t.Fatal("expected unsafe path failure")
	}
}
