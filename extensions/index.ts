import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInspectContextTool, type InspectContextToolOptions } from "../src/adapter.ts";
import { registerSessionInspectContext } from "./typescript.ts";

export function registerInspectContext(pi: ExtensionAPI, options: InspectContextToolOptions = {}): void {
	if (options.workerPath !== undefined) {
		pi.registerTool(createInspectContextTool(options));
		return;
	}
	registerSessionInspectContext(pi, options);
}

export default function registerInspectContextExtension(pi: ExtensionAPI): void {
	registerInspectContext(pi);
}
