import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../agent-reviewer.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoVersion(): string {
	return readFileSync(join(ROOT, "VERSION"), "utf8").trim();
}

/** Same extraction `scripts/install.sh` uses on dest `agent-reviewer.ts`. */
function pluginVersionFromSource(src: string): string {
	const m = src.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/);
	return m?.[1] ?? "unknown";
}

test("PLUGIN_VERSION matches root VERSION", () => {
	expect(PLUGIN_VERSION).toBe(repoVersion());
});

test("install.sh-style parse of agent-reviewer.ts matches VERSION", () => {
	const src = readFileSync(join(ROOT, "agent-reviewer.ts"), "utf8");
	expect(pluginVersionFromSource(src)).toBe(repoVersion());
});
