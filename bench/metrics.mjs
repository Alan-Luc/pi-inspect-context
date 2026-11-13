export function rankedExcerptPaths(packet) {
	const seen = new Set();
	return packet.excerpts.flatMap(({ path, kind }) => {
		if (kind === "governing" || seen.has(path)) return [];
		seen.add(path);
		return [path];
	});
}

export function recallAt5(packet, expectedPaths) {
	const top = new Set(rankedExcerptPaths(packet).slice(0, 5));
	return expectedPaths.length ? expectedPaths.filter((path) => top.has(path)).length / expectedPaths.length : 1;
}

export function labelAccuracy(packet, expected) {
	if (!expected.length) return 1;
	return expected.filter(({ path, line, kind }) => packet.excerpts.some((excerpt) =>
		excerpt.path === path && excerpt.kind === kind && line >= excerpt.startLine && line <= excerpt.endLine,
	)).length / expected.length;
}

export function measureBytes(packet, modelContent) {
	const packetText = JSON.stringify(packet);
	const contentBytes = Buffer.byteLength(modelContent, "utf8");
	return { packetBytes: Buffer.byteLength(packetText, "utf8"), contentBytes, contentTokens: Math.ceil(contentBytes / 4) };
}

export function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
