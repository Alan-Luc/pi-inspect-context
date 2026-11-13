import { OMISSION_REASONS, type OmissionGroup, type OmissionReason, type ResearchPacketV1 } from "../../src/packet.ts";

type RequireTrue<Value extends true> = Value;
export type UnknownReasonRejected = RequireTrue<"outside_reason" extends OmissionReason ? false : true>;
export const reasons: OmissionReason[] = [...OMISSION_REASONS];
export const group: OmissionGroup = { reason: "package_scope", count: 1, examples: ["sibling.ts"] };
export const packetReason: ResearchPacketV1["omissions"][number]["reason"] = "excerpt_limit";
