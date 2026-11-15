import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InspectContextToolOptions } from "../src/adapter.ts";
import { registerSessionInspectContext } from "./typescript.ts";

export function registerInspectContext(pi: ExtensionAPI, options: InspectContextToolOptions = {}): void {
	registerSessionInspectContext(pi, options);
}

export default function registerInspectContextExtension(pi: ExtensionAPI): void {
	registerInspectContext(pi);
}
