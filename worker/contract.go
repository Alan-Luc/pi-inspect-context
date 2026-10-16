package inspectcontext

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"strings"
	"unicode"
)

const (
	protocolVersion             = 1
	policyVersion               = "inspect-context-mini-v6"
	maxQueryBytes               = 4_096
	maxPacketBytes              = 49_152
	targetPacketBytes           = 32_768
	maxDiscoveredFiles          = 2_000
	maxAggregateReadBytes       = 8_388_608
	maxExcerpts                 = 64
	primaryRetrievalWindowLimit = 24
	maxExcerptLines             = 80
	maxEvidencePerCategory      = 32
	maxUnknowns                 = 32
	maxOmissionGroups           = 32
	maxOmissionExamples         = 4
)

type workerRequest struct {
	Version int    `json:"version"`
	Root    string `json:"root"`
	Query   string `json:"query"`
}

type authorizationManifest struct {
	Version int    `json:"version"`
	Root    string `json:"root"`
}

type researchPacket struct {
	Version            int             `json:"version"`
	Target             packetTarget    `json:"target"`
	Snapshot           packetSnapshot  `json:"snapshot"`
	GoverningArtifacts []evidenceRef   `json:"governingArtifacts"`
	Definitions        []evidenceRef   `json:"definitions"`
	Callers            []evidenceRef   `json:"callers"`
	Imports            []evidenceRef   `json:"imports"`
	Tests              []evidenceRef   `json:"tests"`
	Configuration      []evidenceRef   `json:"configuration"`
	Matches            []evidenceRef   `json:"matches"`
	Excerpts           []excerpt       `json:"excerpts"`
	Unknowns           []string        `json:"unknowns"`
	Omissions          []omissionGroup `json:"omissions"`
	Receipt            receipt         `json:"receipt"`
}

type packetTarget struct {
	Query      string `json:"query"`
	Root       string `json:"root"`
	Repository string `json:"repository"`
}

type packetSnapshot struct {
	Revision  *string `json:"revision,omitempty"`
	ID        string  `json:"id"`
	Validated bool    `json:"validated"`
}

type evidenceRef struct {
	ExcerptID  string `json:"excerptId"`
	Path       string `json:"path"`
	StartLine  int    `json:"startLine"`
	EndLine    int    `json:"endLine"`
	Confidence string `json:"confidence"`
	Reason     string `json:"reason"`
}

type excerpt struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
}

type omissionGroup struct {
	Reason   string   `json:"reason"`
	Count    int      `json:"count"`
	Examples []string `json:"examples,omitempty"`
}

type receipt struct {
	PacketID        string `json:"packetId"`
	SchemaVersion   int    `json:"schemaVersion"`
	PolicyVersion   string `json:"policyVersion"`
	SnapshotID      string `json:"snapshotId"`
	DurationMS      int64  `json:"durationMs"`
	DiscoveredFiles int    `json:"discoveredFiles"`
	ReadFiles       int    `json:"readFiles"`
	BytesRead       int64  `json:"bytesRead"`
	ExcerptCount    int    `json:"excerptCount"`
	OmissionCount   int    `json:"omissionCount"`
}

var omissionReasons = map[string]struct{}{
	"aggregate_byte_limit": {},
	"binary_file":          {},
	"dependency_or_vendor": {},
	"excerpt_limit":        {},
	"file_limit":           {},
	"generated_or_build":   {},
	"ineligible_file":      {},
	"invalid_utf8":         {},
	"oversized_file":       {},
	"packet_limit":         {},
	"read_error":           {},
}

var excerptKinds = map[string]struct{}{
	"governing":     {},
	"definition":    {},
	"caller":        {},
	"import":        {},
	"test":          {},
	"configuration": {},
	"match":         {},
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
	return nil
}

func validateRequest(request workerRequest) error {
	if request.Version != protocolVersion {
		return fmt.Errorf("unsupported request version: %d", request.Version)
	}
	if err := validateRoot(request.Root); err != nil {
		return err
	}
	return validateQuery(request.Query)
}

func validateManifest(manifest authorizationManifest) error {
	if manifest.Version != protocolVersion {
		return fmt.Errorf("unsupported manifest version: %d", manifest.Version)
	}
	return validateRoot(manifest.Root)
}

func validateRoot(root string) error {
	if root == "" || strings.IndexByte(root, 0) >= 0 || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return errors.New("root must be a clean, NUL-free absolute path")
	}
	return nil
}

func validateQuery(query string) error {
	if query == "" {
		return errors.New("query must not be empty")
	}
	if strings.IndexByte(query, 0) >= 0 {
		return errors.New("query must not contain NUL")
	}
	if !strings.ContainsFunc(query, func(value rune) bool {
		return value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value)
	}) {
		return errors.New("query must contain at least one letter, number, or underscore")
	}
	if len([]byte(query)) > maxQueryBytes {
		return fmt.Errorf("query exceeds %d UTF-8 bytes", maxQueryBytes)
	}
	return nil
}

func validatePacket(packet researchPacket) error {
	if packet.Version != 1 || packet.Target.Root != "." {
		return errors.New("invalid packet version or target root")
	}
	if err := validateQuery(packet.Target.Query); err != nil {
		return fmt.Errorf("invalid target query: %w", err)
	}
	if packet.Target.Repository != "git" && packet.Target.Repository != "filesystem" {
		return errors.New("invalid repository kind")
	}
	if packet.Snapshot.ID == "" || !packet.Snapshot.Validated {
		return errors.New("snapshot must be identified and validated")
	}
	if packet.Excerpts == nil || packet.Unknowns == nil || packet.Omissions == nil {
		return errors.New("packet arrays must not be null")
	}
	if len(packet.Excerpts) > maxExcerpts || len(packet.Unknowns) > maxUnknowns || len(packet.Omissions) > maxOmissionGroups {
		return errors.New("packet array exceeds its bound")
	}

	excerpts := make(map[string]excerpt, len(packet.Excerpts))
	for _, item := range packet.Excerpts {
		if item.ID == "" || item.StartLine < 1 || item.EndLine < item.StartLine || item.EndLine-item.StartLine+1 > maxExcerptLines || item.Text == "" {
			return errors.New("invalid excerpt")
		}
		if err := validatePacketPath(item.Path); err != nil {
			return err
		}
		if _, ok := excerptKinds[item.Kind]; !ok {
			return fmt.Errorf("invalid excerpt kind: %s", item.Kind)
		}
		if _, exists := excerpts[item.ID]; exists {
			return fmt.Errorf("duplicate excerpt id: %s", item.ID)
		}
		excerpts[item.ID] = item
	}

	categories := [][]evidenceRef{
		packet.GoverningArtifacts,
		packet.Definitions,
		packet.Callers,
		packet.Imports,
		packet.Tests,
		packet.Configuration,
		packet.Matches,
	}
	for _, category := range categories {
		if category == nil {
			return errors.New("evidence arrays must not be null")
		}
		if len(category) > maxEvidencePerCategory {
			return errors.New("evidence category exceeds its bound")
		}
		for _, reference := range category {
			item, exists := excerpts[reference.ExcerptID]
			if !exists || item.Path != reference.Path || item.StartLine != reference.StartLine || item.EndLine != reference.EndLine {
				return errors.New("evidence reference does not match its excerpt")
			}
			if reference.Confidence != "observed" && reference.Confidence != "candidate" {
				return errors.New("invalid evidence confidence")
			}
			if reference.Reason == "" {
				return errors.New("evidence reason must not be empty")
			}
		}
	}

	omissionCount := 0
	for _, omission := range packet.Omissions {
		if _, ok := omissionReasons[omission.Reason]; !ok || omission.Count < 0 || len(omission.Examples) > maxOmissionExamples {
			return errors.New("invalid omission group")
		}
		for _, example := range omission.Examples {
			if err := validatePacketPath(example); err != nil {
				return err
			}
		}
		omissionCount += omission.Count
	}

	if packet.Receipt.PacketID == "" || packet.Receipt.SchemaVersion != 1 || packet.Receipt.PolicyVersion != policyVersion || packet.Receipt.SnapshotID != packet.Snapshot.ID {
		return errors.New("invalid receipt identity")
	}
	if packet.Receipt.DurationMS < 0 || packet.Receipt.DiscoveredFiles < 0 || packet.Receipt.DiscoveredFiles > maxDiscoveredFiles || packet.Receipt.ReadFiles < 0 || packet.Receipt.ReadFiles > packet.Receipt.DiscoveredFiles || packet.Receipt.BytesRead < 0 || packet.Receipt.BytesRead > maxAggregateReadBytes {
		return errors.New("invalid receipt counters")
	}
	if packet.Receipt.ExcerptCount != len(packet.Excerpts) || packet.Receipt.OmissionCount != omissionCount {
		return errors.New("receipt counts do not match packet")
	}
	encoded, err := json.Marshal(packet)
	if err != nil {
		return err
	}
	if len(encoded) > maxPacketBytes {
		return fmt.Errorf("packet exceeds %d bytes", maxPacketBytes)
	}
	return nil
}

func validatePacketPath(value string) error {
	if value == "" || strings.Contains(value, "\\") || strings.IndexByte(value, 0) >= 0 || path.IsAbs(value) || path.Clean(value) != value || value == "." || value == ".." || strings.HasPrefix(value, "../") {
		return fmt.Errorf("unsafe packet path: %q", value)
	}
	return nil
}
