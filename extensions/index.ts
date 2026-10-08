import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInspectContextTool, type InspectContextToolOptions } from "../src/adapter.ts";

export function registerInspectContext(pi: ExtensionAPI, options: InspectContextToolOptions = {}): void {
	pi.registerTool(createInspectContextTool(options));
}

export default function registerInspectContextExtension(pi: ExtensionAPI): void {
	registerInspectContext(pi);
}
