#!/usr/bin/env node
/**
 * Link the installed DeepSeek Harness packages this bundle imports into this
 * checkout, so a *local-path* install can resolve them.
 *
 * Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
 * and Node's ESM resolver follows that symlink to this repository's real path.
 * Resolution then walks up from here and never reaches the profile's
 * node_modules. A git install has no such problem, so this is a development
 * convenience, not part of a normal install.
 *
 * Usage: node scripts/dev-link.mjs [directory containing @deepseek-ai/dsh-*]
 *   DSH_PACKAGE_DIR  same, via environment
 *
 * Node port of `dev-link.sh`: same package list, same messages. The only
 * difference is the link type — Windows junctions need no elevation, while a
 * POSIX directory symlink is what `ln -s` produced.
 *
 * @module dsh-resume-budget/scripts/dev-link
 */

import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["schemastery", "dsh-compaction", "dsh-token-meter"];

/**
 * Follow a chain of symlinks the way the shell script's `readlink` loop did.
 *
 * @param target - filesystem path, possibly a symlink.
 * @returns the final target, or the input when it is not a symlink.
 */
function resolveSymlinks(target) {
	let current = resolve(target);
	const seen = new Set();
	while (true) {
		let stats;
		try {
			stats = lstatSync(current);
		} catch {
			return current;
		}
		if (!stats.isSymbolicLink() || seen.has(current)) return current;
		seen.add(current);
		current = resolve(dirname(current), readlinkSync(current));
	}
}

/**
 * Find an executable on PATH, honouring PATHEXT on Windows.
 *
 * @param name - the command name without extension.
 * @returns the first match, or `undefined`.
 */
function findOnPath(name) {
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		// Windows allows a quoted PATH entry; keep the quotes out of the join.
		const entry = directory.replace(/^"(.*)"$/, "$1");
		if (entry === "") continue;
		for (const extension of extensions) {
			const candidate = join(entry, name + extension);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here; keep looking.
			}
		}
	}
	return undefined;
}

/**
 * Whether a directory holds the harness packages this bundle imports.
 *
 * @param directory - the `@deepseek-ai` directory to test.
 * @returns `true` when both packages are present.
 */
function hasPackages(directory) {
	if (!directory) return false;
	const has = (name) => {
		try {
			return lstatSync(join(directory, name)).isDirectory();
		} catch {
			return false;
		}
	};
	return has("schemastery") && has("dsh-token-meter");
}

/** Fails the run with the shell script's diagnostic. */
function fail(message) {
	console.error(message);
	process.exit(1);
}

let packageDir = process.argv[2] || process.env.DSH_PACKAGE_DIR || "";

if (packageDir === "") {
	const dshBin = findOnPath("dsh");
	if (dshBin === undefined) {
		fail("dev-link: cannot find 'dsh' on PATH; pass the directory holding @deepseek-ai/dsh-* instead");
	}
	const binDir = dirname(resolveSymlinks(dshBin));
	const dshPkg = resolve(binDir, "..");
	const candidates = [
		// A pnpm/npm global install that keeps the harness packages beside dsh.
		join(dshPkg, "node_modules", "@deepseek-ai"),
		// The hoisted layout the shell script already handled on macOS/Linux.
		dirname(dshPkg),
		// npm's Windows layout: the dsh.cmd shim sits in the npm prefix and the
		// packages live under <prefix>/node_modules/@deepseek-ai.
		join(binDir, "node_modules", "@deepseek-ai"),
		// …and the nested copy npm creates for dsh's own dependencies.
		join(binDir, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai")
	];
	for (const candidate of candidates) {
		if (hasPackages(candidate)) {
			packageDir = candidate;
			break;
		}
	}
}

if (!hasPackages(packageDir)) {
	fail(`dev-link: no schemastery/dsh-token-meter under '${packageDir || "<unresolved>"}'`);
}

const targetRoot = resolve(packageDir);
const linkRoot = join(here, "node_modules", "@deepseek-ai");
mkdirSync(linkRoot, { recursive: true });

for (const pkg of packages) {
	const link = join(linkRoot, pkg);
	try {
		const stats = lstatSync(link);
		if (!stats.isSymbolicLink()) {
			fail(`dev-link: ${link} exists and is not a symlink; remove it and retry`);
		}
		unlinkSync(link);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	symlinkSync(join(targetRoot, pkg), link, process.platform === "win32" ? "junction" : "dir");
	console.log(`dev-link: linked ${pkg}`);
}

console.log("dev-link: local-path installs can now resolve the harness packages");
