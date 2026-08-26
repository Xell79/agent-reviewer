import { expect, test } from "bun:test";
import {
	decrementActive,
	incrementActive,
	selectLeastConnections,
	withTierConnection,
} from "../lib/least-connections.ts";

const tiers = [{ name: "a" }, { name: "b" }, { name: "c" }];

function names(
	counts: Record<string, number>,
	attempted: string[] = [],
	cooling: string[] = [],
): string | null {
	const map = new Map(Object.entries(counts));
	return (
		selectLeastConnections(
			tiers,
			map,
			new Set(attempted),
			new Set(cooling),
		)?.name ?? null
	);
}

test("all idle chooses first in order", () => {
	expect(names({})).toBe("a");
	expect(names({ a: 0, b: 0, c: 0 })).toBe("a");
});

test("busy primary chooses idle second", () => {
	expect(names({ a: 1 })).toBe("b");
	expect(names({ a: 2, b: 0, c: 0 })).toBe("b");
});

test("equal counts use order", () => {
	expect(names({ a: 1, b: 1, c: 1 })).toBe("a");
	expect(names({ a: 2, b: 2, c: 2 })).toBe("a");
	expect(names({ a: 2, b: 2 })).toBe("c");
});

test("cooling and attempted are excluded", () => {
	expect(names({}, [], ["a"])).toBe("b");
	expect(names({}, ["a"], [])).toBe("b");
	expect(names({ b: 1 }, ["a"], [])).toBe("c");
	expect(names({}, ["a", "b"], ["c"])).toBe(null);
});

test("all busy chooses the smallest count", () => {
	expect(names({ a: 3, b: 1, c: 2 })).toBe("b");
	expect(names({ a: 2, b: 2, c: 1 })).toBe("c");
});

test("all excluded returns none", () => {
	expect(names({}, ["a", "b", "c"])).toBe(null);
	expect(names({ a: 0 }, [], ["a", "b", "c"])).toBe(null);
	expect(selectLeastConnections([], new Map(), new Set(), new Set())).toBe(
		null,
	);
});

test("increment/decrement deletes zero entries", () => {
	const map = new Map<string, number>();
	expect(incrementActive(map, "a")).toBe(1);
	expect(incrementActive(map, "a")).toBe(2);
	expect(decrementActive(map, "a")).toBe(1);
	expect(map.get("a")).toBe(1);
	expect(decrementActive(map, "a")).toBe(0);
	expect(map.has("a")).toBe(false);
	expect(decrementActive(map, "missing")).toBe(0);
	expect(map.has("missing")).toBe(false);
});

test("withTierConnection decrements after success and throw", async () => {
	const map = new Map<string, number>();
	await withTierConnection(map, "a", async () => {
		expect(map.get("a")).toBe(1);
		return "ok";
	});
	expect(map.has("a")).toBe(false);

	await expect(
		withTierConnection(map, "b", async () => {
			expect(map.get("b")).toBe(1);
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	expect(map.has("b")).toBe(false);
});

test("concurrent calls: no request retries a failed tier; counts settle to zero", async () => {
	const map = new Map<string, number>();
	const attemptedA = new Set<string>();
	const attemptedB = new Set<string>();
	const seen: string[] = [];
	let releaseA: () => void = () => {};
	const holdA = new Promise<void>((resolve) => {
		releaseA = resolve;
	});

	const run = async (
		attempted: Set<string>,
		call: (name: string) => Promise<string>,
	): Promise<string[]> => {
		const used: string[] = [];
		while (true) {
			const t = selectLeastConnections(
				tiers,
				map,
				attempted,
				new Set(),
			);
			if (!t) break;
			attempted.add(t.name);
			used.push(t.name);
			try {
				await withTierConnection(map, t.name, () => call(t.name));
				return used;
			} catch {
				// next remaining tier
			}
		}
		return used;
	};

	const p1 = run(attemptedA, async (name) => {
		seen.push(`p1:${name}`);
		if (name === "a") {
			await holdA;
			throw new Error("fail-a");
		}
		return name;
	});
	// p1 is holding a. Second request must pick b, not retry a.
	await Promise.resolve();
	const p2 = run(attemptedB, async (name) => {
		seen.push(`p2:${name}`);
		return name;
	});

	const used2 = await p2;
	expect(used2).toEqual(["b"]);
	expect(attemptedB.has("a")).toBe(false);
	releaseA();
	const used1 = await p1;
	expect(used1[0]).toBe("a");
	expect(used1.includes("a")).toBe(true);
	expect(new Set(used1).size).toBe(used1.length);
	expect(map.size).toBe(0);
	expect(seen.some((s) => s.startsWith("p2:a"))).toBe(false);
});

test("idle burst: 1→a, 2→b, 3→c; after settle, pick returns to a", async () => {
	const map = new Map<string, number>();
	const gates: Array<() => void> = [];
	const holds = [0, 1, 2].map(
		() =>
			new Promise<void>((resolve) => {
				gates.push(resolve);
			}),
	);

	const startOne = async (i: number) => {
		const attempted = new Set<string>();
		const t = selectLeastConnections(tiers, map, attempted, new Set());
		if (!t) throw new Error("no tier");
		attempted.add(t.name);
		await withTierConnection(map, t.name, async () => {
			await holds[i];
			return t.name;
		});
		return t.name;
	};

	const picks: string[] = [];
	const p0 = startOne(0).then((n) => {
		picks[0] = n;
	});
	await Promise.resolve();
	const p1 = startOne(1).then((n) => {
		picks[1] = n;
	});
	await Promise.resolve();
	const p2 = startOne(2).then((n) => {
		picks[2] = n;
	});
	await Promise.resolve();

	expect([...map.keys()].sort()).toEqual(["a", "b", "c"]);
	expect(map.get("a")).toBe(1);
	expect(map.get("b")).toBe(1);
	expect(map.get("c")).toBe(1);
	expect(selectLeastConnections(tiers, map, new Set(), new Set())?.name).toBe(
		"a",
	);

	for (const g of gates) g();
	await Promise.all([p0, p1, p2]);
	expect(picks).toEqual(["a", "b", "c"]);
	expect(map.size).toBe(0);
	expect(selectLeastConnections(tiers, map, new Set(), new Set())?.name).toBe(
		"a",
	);
});
