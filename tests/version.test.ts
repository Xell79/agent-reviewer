import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoVersion(): string {
	return readFileSync(join(ROOT, "VERSION"), "utf8").trim();
}

/** Same extraction `scripts/install.sh` uses on dest `agent-reviewer.ts`. */
function pluginVersionFromSource(src: string): string {
	const m = src.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/);
	return m?.[1] ?? "unknown";
}

test("PLUGIN_VERSION in agent-reviewer.ts matches root VERSION", () => {
	const src = readFileSync(join(ROOT, "agent-reviewer.ts"), "utf8");
	expect(pluginVersionFromSource(src)).toBe(repoVersion());
});

test("entrypoint named exports are only the plugin factory", () => {
	const src = readFileSync(join(ROOT, "agent-reviewer.ts"), "utf8");
	const named = [
		...src.matchAll(/^export (?:async )?(?:const|function|class|type|interface) (\w+)/gm),
	].map((m) => m[1]);
	expect(named).toEqual(["AgentReviewerPlugin"]);
	expect(src).toContain("export default AgentReviewerPlugin");
});
