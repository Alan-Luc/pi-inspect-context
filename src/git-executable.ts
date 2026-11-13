import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export function resolveGitExecutable(searchPath: string): string {
	if (process.platform !== "darwin") return "git";
	let systemLauncher = false;
	for (const directory of searchPath.split(":")) {
		const candidate = join(directory, "git");
		try {
			accessSync(candidate, constants.X_OK);
			if (!statSync(candidate).isFile()) continue;
		} catch {
			continue;
		}
		systemLauncher = candidate === "/usr/bin/git";
		break;
	}
	if (!systemLauncher) return "git";
	const discovery = spawnSync("/usr/bin/xcrun", ["--find", "git"], {
		encoding: "utf8", shell: false, timeout: 2000, maxBuffer: 4096,
		env: { PATH: searchPath, LANG: "C", LC_ALL: "C" },
	});
	if (discovery.error || discovery.status !== 0 || !/^\/[^\r\n\0]+\n$/.test(discovery.stdout)) return "git";
	const executable = discovery.stdout.slice(0, -1);
	if (!isAbsolute(executable) || normalize(executable) !== executable || executable === "/usr/bin/git") return "git";
	try {
		const metadata = lstatSync(executable);
		if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) return "git";
	} catch {
		return "git";
	}
	return executable;
}
