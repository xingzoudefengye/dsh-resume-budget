#!/usr/bin/env node
/**
 * Verify one profile's resume-budget wiring, cross-platform.
 *
 * This is the Node port of `check.sh` and performs exactly the same two
 * checks against the same composed tree:
 *
 *   1. the `resume-budget` row is present;
 *   2. its `thresholdTokens` is the value the deployment means to run.
 *
 * Usage: node scripts/check.mjs [profile] [expected-threshold]
 *   (defaults: web, 100000)
 *
 * It is deliberately dependency-free: Node's own path/os/fs/child_process are
 * all it needs, so it runs on a fresh clone before `pnpm install`.
 *
 * The one platform difference it hides is how `dsh` is launched. npm installs
 * the command as a `dsh.cmd` shim on Windows; libuv never searches PATHEXT, so
 * spawning `"dsh"` fails with ENOENT, while spawning `"dsh.cmd"` fails with
 * EINVAL because Node refuses to run a batch file without a shell. A quoted
 * command line through the shell is the portable way in, and passing it as one
 * pre-quoted string (rather than `shell: true` plus an args array) avoids the
 * DEP0190 warning Node raises for unescaped shell arguments.
 *
 * @module dsh-resume-budget/scripts/check
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const profile = process.argv[2] || "web";
const expected = process.argv[3] || "100000";
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", profile);

if (!existsSync(profileDir)) {
	console.error(`FAIL: no such profile: ${profileDir}`);
	process.exit(1);
}

/**
 * Quote one argument for cmd.exe.
 *
 * `--profile` and the profile name are the only values that ever reach the
 * shell, and a profile name containing a quote, a percent sign (cmd.exe would
 * expand it as a variable) or a newline cannot be passed through cmd.exe
 * unambiguously. Refuse it instead of running something else.
 *
 * @param value - the argument.
 * @returns the argument inside double quotes.
 */
function quoteForCmd(value) {
	const text = String(value);
	if (/["%\r\n]/.test(text)) {
		throw new Error(`cannot pass ${JSON.stringify(text)} through cmd.exe; use a profile name without quotes, percent signs or newlines`);
	}
	return `"${text}"`;
}

/**
 * Run `dsh --profile <profile> --dump-config` into a private temp file.
 *
 * stdout goes to the file (as `check.sh` redirects it), while stderr is
 * inherited so a boot failure still explains itself to the person running
 * this.
 *
 * @param dumpPath - file to write the composed tree to.
 * @returns the `spawnSync` result.
 */
function dumpConfig(dumpPath) {
	const args = ["--profile", profile, "--dump-config"];
	const fd = openSync(dumpPath, "w");
	try {
		if (process.platform === "win32") {
			return spawnSync(args.reduce((line, arg) => `${line} ${quoteForCmd(arg)}`, "dsh"), {
				shell: true,
				stdio: ["ignore", fd, "inherit"]
			});
		}
		return spawnSync("dsh", args, { stdio: ["ignore", fd, "inherit"] });
	} finally {
		closeSync(fd);
	}
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-resume-budget-"));
const dumpPath = join(scratch, "dump-config.yml");
let status = 0;

try {
	let result;
	try {
		result = dumpConfig(dumpPath);
	} catch (error) {
		console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (result.error) {
		console.error(`FAIL: cannot run dsh: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`FAIL: dsh --profile ${profile} --dump-config exited with ${result.status ?? "no status"}`);
		process.exit(result.status ?? 1);
	}

	const dump = readFileSync(dumpPath, "utf8");
	if (dump.includes("id: resume-budget")) {
		console.log("ok:   resume-budget is in the composed tree");
	} else {
		console.error(`FAIL: resume-budget is missing — install this bundle: dsh plugin --profile ${profile} add github:xingzoudefengye/dsh-resume-budget`);
		status = 1;
	}

	if (dump.includes(`thresholdTokens: ${expected}`)) {
		console.log(`ok:   thresholdTokens is ${expected}`);
	} else {
		console.error(`WARN: thresholdTokens ${expected} not found in the composed tree`);
	}

	process.exitCode = status;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
