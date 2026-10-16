import { Type, type Static } from "typebox";

export const POLICY_VERSION = "inspect-context-mini-v7" as const;
export const WORKER_PROTOCOL_VERSION = 1 as const;
export const MAX_QUERY_BYTES = 4_096;
export const MAX_DISCOVERED_FILES = 2_000;
export const MAX_FILE_BYTES = 65_536;
export const MAX_AGGREGATE_READ_BYTES = 8_388_608;
export const MAX_EXCERPTS = 64;
export const MAX_EXCERPT_LINES = 80;
export const MAX_PACKET_BYTES = 49_152;
export const MAX_EVIDENCE_PER_CATEGORY = 32;
export const MAX_UNKNOWNS = 32;
export const MAX_OMISSION_GROUPS = 32;
export const MAX_OMISSION_EXAMPLES = 4;

const SEARCHABLE_QUERY_CHARACTER = /[\p{L}\p{N}_]/u;

export const OMISSION_REASONS = [
	"aggregate_byte_limit",
	"binary_file",
	"dependency_or_vendor",
	"excerpt_limit",
	"file_limit",
	"generated_or_build",
	"ineligible_file",
	"invalid_utf8",
	"oversized_file",
	"packet_limit",
	"read_error",
] as const;

const EvidenceRefSchema = Type.Object(
	{
		excerptId: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
		confidence: Type.Union([Type.Literal("observed"), Type.Literal("candidate")]),
		reason: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const ExcerptSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
		kind: Type.Union([
			Type.Literal("governing"),
			Type.Literal("definition"),
			Type.Literal("caller"),
			Type.Literal("import"),
			Type.Literal("test"),
			Type.Literal("configuration"),
			Type.Literal("match"),
		]),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

const OmissionGroupSchema = Type.Object(
	{
		reason: Type.Union(OMISSION_REASONS.map((reason) => Type.Literal(reason))),
		count: Type.Integer({ minimum: 0 }),
		examples: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_OMISSION_EXAMPLES })),
	},
	{ additionalProperties: false },
);

const ReceiptSchema = Type.Object(
	{
		packetId: Type.String({ minLength: 1 }),
		schemaVersion: Type.Literal(1),
		policyVersion: Type.Literal(POLICY_VERSION),
		snapshotId: Type.String({ minLength: 1 }),
		durationMs: Type.Integer({ minimum: 0 }),
		discoveredFiles: Type.Integer({ minimum: 0 }),
		readFiles: Type.Integer({ minimum: 0 }),
		bytesRead: Type.Integer({ minimum: 0 }),
		excerptCount: Type.Integer({ minimum: 0 }),
		omissionCount: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const INSPECT_CONTEXT_PARAMETERS = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: MAX_QUERY_BYTES,
			description: "One short symbol, route, config key, path fragment, or concept. Exact identifiers such as loadUserProfile, /health/ready, and CACHE_CONFIG_PATH work best. For a task spanning multiple seams, combine 2-5 exact anchors in one query, use the returned paths first, and repeat only for a missing branch.",
		}),
	},
	{ additionalProperties: false },
);

export const WORKER_REQUEST_SCHEMA = Type.Object(
	{
		version: Type.Literal(WORKER_PROTOCOL_VERSION),
		root: Type.String({ minLength: 1 }),
		query: Type.String({ minLength: 1, maxLength: MAX_QUERY_BYTES }),
	},
	{ additionalProperties: false },
);

export const AUTHORIZATION_MANIFEST_SCHEMA = Type.Object(
	{
		version: Type.Literal(WORKER_PROTOCOL_VERSION),
		root: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const RESEARCH_PACKET_V1_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		target: Type.Object(
			{
				query: Type.String({ minLength: 1, maxLength: MAX_QUERY_BYTES }),
				root: Type.Literal("."),
				repository: Type.Union([Type.Literal("git"), Type.Literal("filesystem")]),
			},
			{ additionalProperties: false },
		),
		snapshot: Type.Object(
			{
				revision: Type.Optional(Type.String()),
				id: Type.String({ minLength: 1 }),
				validated: Type.Literal(true),
			},
			{ additionalProperties: false },
		),
		governingArtifacts: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		definitions: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		callers: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		imports: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		tests: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		configuration: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		matches: Type.Array(EvidenceRefSchema, { maxItems: MAX_EVIDENCE_PER_CATEGORY }),
		excerpts: Type.Array(ExcerptSchema, { maxItems: MAX_EXCERPTS }),
		unknowns: Type.Array(Type.String(), { maxItems: MAX_UNKNOWNS }),
		omissions: Type.Array(OmissionGroupSchema, { maxItems: MAX_OMISSION_GROUPS }),
		receipt: ReceiptSchema,
	},
	{ additionalProperties: false },
);

export type InspectContextParameters = Static<typeof INSPECT_CONTEXT_PARAMETERS>;
export type WorkerRequest = Static<typeof WORKER_REQUEST_SCHEMA>;
export type AuthorizationManifest = Static<typeof AUTHORIZATION_MANIFEST_SCHEMA>;
export type ResearchPacketV1 = Static<typeof RESEARCH_PACKET_V1_SCHEMA>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type Excerpt = Static<typeof ExcerptSchema>;
export type OmissionGroup = Static<typeof OmissionGroupSchema>;
export type ExcerptKind = Excerpt["kind"];
export type OmissionReason = OmissionGroup["reason"];

export class InspectContextError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "InspectContextError";
		this.code = code;
	}
}

export function normalizeQuery(params: unknown): string {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new InspectContextError("invalid_query", "input must be an object containing only query");
	}
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "query") {
		throw new InspectContextError("invalid_query", "input must contain exactly one query property");
	}
	const query = (params as { query?: unknown }).query;
	if (typeof query !== "string") {
		throw new InspectContextError("invalid_query", "query must be a string");
	}
	const normalized = query.normalize("NFC");
	if (normalized.length === 0) {
		throw new InspectContextError("invalid_query", "query must not be empty");
	}
	if (normalized.includes("\0")) {
		throw new InspectContextError("invalid_query", "query must not contain NUL");
	}
	if (!SEARCHABLE_QUERY_CHARACTER.test(normalized)) {
		throw new InspectContextError("invalid_query", "query must contain at least one letter, number, or underscore");
	}
	const bytes = Buffer.byteLength(normalized, "utf8");
	if (bytes > MAX_QUERY_BYTES) {
		throw new InspectContextError("invalid_query", `normalized query is ${bytes} UTF-8 bytes; maximum is ${MAX_QUERY_BYTES}`);
	}
	return normalized;
}

export function packetByteLength(packet: ResearchPacketV1): number {
	return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

export function serializePacket(packet: ResearchPacketV1): string {
	const serialized = JSON.stringify(packet);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > MAX_PACKET_BYTES) {
		throw new InspectContextError("packet_fit_failed", `serialized packet is ${bytes} bytes; maximum is ${MAX_PACKET_BYTES}`);
	}
	return serialized;
}
