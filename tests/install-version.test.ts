import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(ROOT, "scripts", "install.sh");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

async function runInstall(args: string[]): Promise<{
	exit: number;
	stdout: string;
	stderr: string;
}> {
	const proc = Bun.spawn(["bash", INSTALL, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exit, stdout, stderr };
}

test("install.sh --dry-run reports dest unknown when plugin missing", async () => {
	const dest = mkdtempSync(join(tmpdir(), "ar-dest-"));
	const { exit, stdout, stderr } = await runInstall([
		"--dry-run",
		"--no-pull",
		"--src",
		ROOT,
		"--dest",
		dest,
	]);
	expect(exit).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toContain(`version: repo ${VERSION}  dest unknown`);
	expect(stdout).toContain(`update available: dest unknown → repo ${VERSION}`);
});

test("install.sh reports in sync after copy", async () => {
	const dest = mkdtempSync(join(tmpdir(), "ar-dest-"));
	mkdirSync(join(dest, "plugin"), { recursive: true });
	mkdirSync(join(dest, "tui"), { recursive: true });
	const { exit, stdout, stderr } = await runInstall([
		"--no-pull",
		"--src",
		ROOT,
		"--dest",
		dest,
	]);
	expect(exit).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toContain(`version: repo ${VERSION}  dest ${VERSION}`);
	expect(stdout).toContain("in sync");
	expect(
		await Bun.file(join(dest, "plugin", "lib", "least-connections.ts")).exists(),
	).toBe(true);
});

test("install.sh reports update available when dest PLUGIN_VERSION is old", async () => {
	const dest = mkdtempSync(join(tmpdir(), "ar-dest-"));
	mkdirSync(join(dest, "plugin"), { recursive: true });
	writeFileSync(
		join(dest, "plugin", "agent-reviewer.ts"),
		'export const PLUGIN_VERSION = "0.0.1";\n',
	);
	const { exit, stdout, stderr } = await runInstall([
		"--dry-run",
		"--no-pull",
		"--src",
		ROOT,
		"--dest",
		dest,
	]);
	expect(exit).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toContain(`version: repo ${VERSION}  dest 0.0.1`);
	expect(stdout).toContain(`update available: dest 0.0.1 → repo ${VERSION}`);
});
