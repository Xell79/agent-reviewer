/**
 * Least-connections pick among runtime `order`. Tie-break = array index.
 * Pure: no Date.now(); caller supplies cooling names. Missing map entries = 0.
 *
 * Not a Kilo plugin — do not add a default export. Auto-scan is plugin/*.{ts,js}
 * (non-recursive); this file is copied to dest plugin/lib/.
 */
export function selectLeastConnections<T extends { name: string }>(
	tiers: readonly T[],
	activeCounts: ReadonlyMap<string, number>,
	attempted: ReadonlySet<string>,
	cooling: ReadonlySet<string>,
): T | null {
	let best: T | null = null;
	let bestActive = Number.POSITIVE_INFINITY;
	let bestIndex = Number.POSITIVE_INFINITY;
	for (let i = 0; i < tiers.length; i++) {
		const t = tiers[i];
		if (attempted.has(t.name) || cooling.has(t.name)) continue;
		const active = activeCounts.get(t.name) ?? 0;
		if (active < bestActive || (active === bestActive && i < bestIndex)) {
			best = t;
			bestActive = active;
			bestIndex = i;
		}
	}
	return best;
}

/** Positive counts only — delete the key at 0 so stale names cannot stick. */
export function incrementActive(
	map: Map<string, number>,
	name: string,
): number {
	const n = (map.get(name) ?? 0) + 1;
	map.set(name, n);
	return n;
}

export function decrementActive(
	map: Map<string, number>,
	name: string,
): number {
	const n = (map.get(name) ?? 0) - 1;
	if (n <= 0) {
		map.delete(name);
		return 0;
	}
	map.set(name, n);
	return n;
}

export function activeCountSnapshot(
	tiers: readonly { name: string }[],
	activeCounts: ReadonlyMap<string, number>,
): { name: string; active: number }[] {
	if (!Array.isArray(tiers)) return [];
	return tiers.map((t) => ({
		name: t.name,
		active: activeCounts.get(t.name) ?? 0,
	}));
}

/** Count one HTTP connection for `name` until `fn` settles (success or throw). */
export async function withTierConnection<T>(
	map: Map<string, number>,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	incrementActive(map, name);
	try {
		return await fn();
	} finally {
		decrementActive(map, name);
	}
}
