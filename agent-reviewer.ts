/**
 * agent-reviewer — pre-auto-approve gate for mutating tools.
 *
 * Mechanism (locked): event hook on `permission.asked` + client.permission.reply.
 * Do NOT use the dead `permission.ask` hook (upstream #9229).
 *
 * Tiers: direct OpenAI-compatible (or Cohere v2) fetch per entry in config.
 * Fail-closed: all tiers operationally fail → leave request to human.
 * First definitive decision (approve or escalate) stops the request; next tier
 * only on operational failure (HTTP/timeout/empty/unparseable). Concurrent
 * reviews pick the least-loaded non-cooling unattempted tier (`order` is the
 * tie-breaker). Operational failure of a tier → skipped for tierCooldownMs
 * (from config, default 30m) so 429/timeouts do not hammer every permission.asked.
 *
 * Config: ~/.config/kilo/agent-reviewer.json (or AGENT_REVIEWER_CONFIG)
 *   tiers:  map name → model settings (not order)
 *   order:  enabled chain (names only); omit a name = disabled
 *   skip:   tool names that bypass the gate (default [])
 *   systemPrompt: gate prompt (optional; falls back to built-in default)
 * Hot-reload: mtime of config re-read on each permission.asked (no Kilo restart).
 */

import {
	activeCountSnapshot,
	selectLeastConnections,
	withTierConnection,
} from "./lib/least-connections.ts";

/** Semver; keep in sync with root `VERSION`. Not a named export (Kilo auto-scan). */
const PLUGIN_VERSION = "0.6.1";

// ---------------------------------------------------------------------------
// File-based debug log (survives when client.app.log is silent / hanging).
// Dedicated under XDG data — NOT mixed into opencode.log. Size-rotated.
// Override dir: AGENT_REVIEWER_LOG_DIR. Default:
//   ~/.local/share/kilo/log/agent-reviewer/{debug,load}.log
// ---------------------------------------------------------------------------
const LOG_DIR =
	process.env.AGENT_REVIEWER_LOG_DIR ||
	`${process.env.XDG_DATA_HOME || `${process.env.HOME ?? ""}/.local/share`}/kilo/log/agent-reviewer`;
const DEBUG_LOG = `${LOG_DIR}/debug.log`;
const LOAD_LOG = `${LOG_DIR}/load.log`;
/**
 * Per-session IPC for TUI reason overlay.
 * One file per Kilo session so overlays never leak across tabs.
 * Same dir as tui/agent-reviewer-tui.tsx.
 */
const PENDING_DIR = `${LOG_DIR}/pending`;
const PENDING_ESCALATE_LEGACY = `${LOG_DIR}/pending-escalate.json`;
const PENDING_STALE_MS = 5 * 60 * 1000;
/** In-process size rotation (appendFileSync reopens each write → rename is safe). */
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const LOG_KEEP = 5; // debug.log.1 .. debug.log.5

function ensureLogDir(fs: typeof import("node:fs")): void {
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
	} catch {
		// ignore
	}
}

/**
 * Size-based rotation: path → path.1 → … → path.N (drop oldest).
 * Safe with appendFileSync (no long-lived fd). Never throws.
 */
function rotateLogIfNeeded(
	fs: typeof import("node:fs"),
	path: string,
	maxBytes = LOG_MAX_BYTES,
	keep = LOG_KEEP,
): void {
	try {
		const st = fs.statSync(path);
		if (!st.isFile() || st.size < maxBytes) return;
		// shift .N-1 → .N, then path → .1
		for (let i = keep; i >= 1; i--) {
			const src = i === 1 ? path : `${path}.${i - 1}`;
			const dst = `${path}.${i}`;
			try {
				if (i === keep) {
					try {
						fs.unlinkSync(dst);
					} catch {
						// no old file
					}
				}
				if (fs.existsSync(src)) fs.renameSync(src, dst);
			} catch {
				// best-effort per slot
			}
		}
	} catch {
		// missing file or stat race — fine
	}
}

function appendLogLine(path: string, line: string): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		ensureLogDir(fs);
		rotateLogIfNeeded(fs, path);
		fs.appendFileSync(path, line, { mode: 0o600 });
	} catch {
		// never throw from logging
	}
}

function dlog(phase: string, data?: unknown) {
	try {
		const line =
			`${new Date().toISOString()} pid=${process.pid} ${phase}` +
			(data !== undefined ? ` ${safeJson(data)}` : "") +
			"\n";
		appendLogLine(DEBUG_LOG, line);
	} catch {
		// never throw from debug
	}
}

type PendingEscalate = {
	requestID: string;
	sessionID?: string;
	permission?: string;
	command?: string;
	reason: string;
	tier?: string;
	model?: string;
	at: number;
};

/** requestIDs the human already answered — do not write leftover overlay IPC. */
const repliedRequestIDs = new Set<string>();

function sessionFileId(sessionID: string | undefined): string | null {
	if (!sessionID) return null;
	if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) return null;
	return sessionID;
}

function pendingPath(sessionID: string): string {
	return `${PENDING_DIR}/${sessionID}.json`;
}

function pruneStalePendingFiles(): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		if (fs.existsSync(PENDING_ESCALATE_LEGACY)) {
			fs.unlinkSync(PENDING_ESCALATE_LEGACY);
			dlog("escalate.pending_legacy_dropped");
		}
		if (!fs.existsSync(PENDING_DIR)) return;
		const now = Date.now();
		for (const name of fs.readdirSync(PENDING_DIR)) {
			if (!name.endsWith(".json")) continue;
			const full = `${PENDING_DIR}/${name}`;
			try {
				const p = JSON.parse(fs.readFileSync(full, "utf8")) as PendingEscalate;
				if (typeof p.at === "number" && now - p.at > PENDING_STALE_MS) {
					fs.unlinkSync(full);
				}
			} catch {
				fs.unlinkSync(full);
			}
		}
	} catch (e) {
		dlog("escalate.pending_prune_fail", { error: String(e) });
	}
}

function clearPendingEscalate(opts?: {
	requestID?: string;
	sessionID?: string;
}): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		const sid = sessionFileId(opts?.sessionID);
		const targets: string[] = [];
		if (sid) targets.push(pendingPath(sid));
		if (fs.existsSync(PENDING_ESCALATE_LEGACY)) {
			targets.push(PENDING_ESCALATE_LEGACY);
		}
		for (const file of targets) {
			if (!fs.existsSync(file)) continue;
			if (opts?.requestID) {
				try {
					const cur = JSON.parse(
						fs.readFileSync(file, "utf8"),
					) as PendingEscalate;
					if (cur?.requestID && cur.requestID !== opts.requestID) continue;
				} catch {
					// corrupt leftover — drop it
				}
			}
			fs.unlinkSync(file);
			dlog("escalate.pending_cleared", {
				requestID: opts?.requestID ?? "any",
				sessionID: opts?.sessionID,
				file,
			});
		}
	} catch (e) {
		dlog("escalate.pending_clear_fail", { error: String(e) });
	}
}

function writePendingEscalate(p: PendingEscalate): void {
	if (repliedRequestIDs.has(p.requestID)) {
		dlog("escalate.pending_skip_already_replied", { requestID: p.requestID });
		return;
	}
	const sid = sessionFileId(p.sessionID);
	if (!sid) {
		dlog("escalate.pending_skip_no_session", { requestID: p.requestID });
		return;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		ensureLogDir(fs);
		fs.mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(pendingPath(sid), `${JSON.stringify(p)}\n`, {
			mode: 0o600,
		});
		dlog("escalate.pending_written", {
			requestID: p.requestID,
			sessionID: sid,
			reason: p.reason,
			tier: p.tier,
			model: p.model,
		});
	} catch (e) {
		dlog("escalate.pending_write_fail", { error: String(e) });
	}
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v, (_k, val) => {
			if (typeof val === "string" && val.length > 400)
				return `${val.slice(0, 400)}…`;
			return val;
		});
	} catch {
		return String(v);
	}
}

// Import-time load marker (proves module was imported by Kilo plugin loader).
try {
	appendLogLine(
		LOAD_LOG,
		`${new Date().toISOString()} import pid=${process.pid} version=${PLUGIN_VERSION} cwd=${process.cwd()}\n`,
	);
	dlog("import", {
		version: PLUGIN_VERSION,
		cwd: process.cwd(),
		logDir: LOG_DIR,
	});
} catch {
	// ignore
}

// No runtime deps — types only, local. PluginInput.client is the Kilo SDK client.

type Decision = "approve" | "escalate";

type TierConfig = {
	name: string;
	baseURL: string;
	/** Literal API key (preferred when already in config). */
	apiKey?: string;
	/** Env var name holding the key (used when apiKey is absent). */
	apiKeyEnv?: string;
	model: string;
	/**
	 * Same endpoint/key: if `model` throws operationally (HTTP/timeout/empty/parse),
	 * try these models in order before failing the tier. Example (Cerebras):
	 * model=gemma-4-31b, fallbackModels=["gpt-oss-120b"].
	 */
	fallbackModels?: string[];
	timeoutMs?: number;
	/** Per-tier override for callReviewer max_tokens (default 512). */
	maxTokens?: number;
	/**
	 * Send response_format: {type:"json_object"}.
	 * Default false — many free/gateway models reject structured outputs (HTTP 400).
	 * Defensive JSON extraction still applies.
	 */
	jsonObject?: boolean;
	/** API wire format. "openai" (default when omitted) = /chat/completions; "cohere-v2" = /v2/chat native; "anthropic" = /v1/messages native. */
	apiFormat?: "openai" | "cohere-v2" | "anthropic";
	/** Cohere v2 only: thinking token budget (limits reasoning tokens). */
	thinkingBudget?: number;
	/**
		 * OpenAI-compatible `reasoning_effort` (e.g. "none" | "low" | "medium" | "high").
		 * Used for Groq qwen3.6 / gpt-oss etc. Omitted from body if unset.
		 * Config key may be `reasoningEffort` or `reasoning_effort`.
		 */
		reasoningEffort?: string;
		/**
		 * OpenRouter-style reasoning token budget: body.reasoning.max_tokens.
		 * Caps CoT on models that cannot disable thinking (MiniMax M2.x).
		 * Config: `reasoningMaxTokens` or nested `reasoning.max_tokens`.
		 */
		reasoningMaxTokens?: number;
	/**
	 * Extra HTTP headers merged after the plugin defaults
	 * (Content-Type, Authorization, User-Agent, Cohere Accept).
	 * On a colliding key, the tier value wins.
	 */
	headers?: Record<string, string>;
};

/** One enabled chain entry is just a name into `tiers` map. */
type TierOrder = string[];

type ReviewerOptions = {
	/**
	 * Model configs keyed by name. Order/enablement is NOT here —
	 * use `order` (names of enabled tiers, first = primary).
	 * Legacy: array of TierConfig (name field required) still accepted.
	 */
	tiers?: Record<string, Omit<TierConfig, "name">> | TierConfig[];
	/**
	 * Enabled chain in priority order. Names must exist in `tiers`.
	 * Names not listed are disabled. Empty/missing → no active tiers (fail-closed).
	 */
	order?: TierOrder;
	/**
	 * Tool names the gate **ignores** (no LLM, no overlay).
	 * Default `[]`: every `permission.asked` is reviewed.
	 * Kilo only emits this event for tools still in `ask` (allow-list in
	 * kilo.jsonc never reaches the plugin).
	 */
	skip?: string[];
	/** Enable hash cache of identical approve decisions (default: true). */
	cache?: boolean;
	/** Per-tier operational cooldown after throw (ms). Default 30m. */
	tierCooldownMs?: number;
	/** Safety-gate system prompt; if empty/missing in config, all asks fail-closed escalate. */
	systemPrompt?: string;
	[key: string]: unknown;
};

/** External config: ~/.config/kilo/agent-reviewer.json (or AGENT_REVIEWER_CONFIG). */
type FileConfig = ReviewerOptions;

/** Resolved snapshot used for one review (or factory log). */
type RuntimeConfig = {
	tiers: TierConfig[];
	skip: string[];
	cache: boolean;
	tierCooldownMs: number;
	systemPrompt: string;
	order: string[];
	path: string;
	mtimeMs: number;
};

type PermissionReply = "once" | "always" | "reject";

/**
 * Kilo plugin client (createKiloClient / FA$).
 * There is NO `client.permission.reply` on the server plugin client.
 * Correct path: POST /session/{id}/permissions/{permissionID}
 *   via `postSessionIdPermissionsPermissionId({ path, body: { response } })`
 * Legacy/alternate: POST /permission/{requestID}/reply with body.reply
 *   may appear as `client.permission.reply` in some SDK builds.
 */
type KiloClient = {
	app?: {
		log?: (params: {
			service?: string;
			level?: "debug" | "info" | "error" | "warn";
			message?: string;
			extra?: Record<string, unknown>;
		}) => Promise<unknown>;
	};
	permission?: {
		reply?: (params: {
			requestID: string;
			reply?: PermissionReply;
			message?: string;
			directory?: string;
			workspace?: string;
			interactive?: boolean;
		}) => Promise<unknown>;
	};
	/** Primary SDK method on plugin client (FA$). */
	postSessionIdPermissionsPermissionId?: (params: {
		path: { id: string; permissionID: string };
		body?: { response: PermissionReply };
		query?: { directory?: string };
	}) => Promise<unknown>;
	[key: string]: unknown;
};

type PluginInput = {
	client: KiloClient;
	directory: string;
	worktree: string;
	serverUrl?: URL | string;
};

/** Reply to a pending permission request using whatever client surface is available. */
async function replyPermission(
	client: KiloClient,
	opts: {
		requestID: string;
		sessionID?: string;
		reply: PermissionReply;
		directory?: string;
	},
): Promise<{ ok: true; via: string } | { ok: false; error: string }> {
	const { requestID, sessionID, reply, directory } = opts;
	const errors: string[] = [];

	// 1) Canonical plugin SDK method (FA$ / createKiloClient)
	// POST /session/{id}/permissions/{permissionID}  body: { response: "once"|"always"|"reject" }
	const postFn = client.postSessionIdPermissionsPermissionId;
	if (typeof postFn === "function") {
		if (!sessionID) {
			errors.push("postSessionIdPermissionsPermissionId needs sessionID");
		} else {
			try {
				const res = await postFn.call(client, {
					path: { id: sessionID, permissionID: requestID },
					body: { response: reply },
					...(directory ? { query: { directory } } : {}),
				});
				// hey-api returns { data, error, ... } — treat error field as failure
				const err =
					res && typeof res === "object" && "error" in res
						? (res as { error?: unknown }).error
						: undefined;
				if (err) {
					errors.push(`postSession: ${safeJson(err)}`);
					dlog("reply.sdk.session_permissions.error", {
						requestID,
						error: err,
					});
				} else {
					dlog("reply.sdk.session_permissions", {
						requestID,
						sessionID,
						reply,
						res: safeJson(res),
					});
					return { ok: true, via: "postSessionIdPermissionsPermissionId" };
				}
			} catch (e) {
				errors.push(`postSession throw: ${String(e)}`);
				dlog("reply.sdk.session_permissions.fail", {
					requestID,
					error: String(e),
				});
			}
		}
	} else {
		errors.push("no postSessionIdPermissionsPermissionId on client");
	}

	// 2) Legacy client.permission.reply (some SDK/TUI builds)
	if (typeof client.permission?.reply === "function") {
		try {
			await client.permission.reply({
				requestID,
				reply,
				...(directory ? { directory } : {}),
			});
			return { ok: true, via: "permission.reply" };
		} catch (e) {
			errors.push(`permission.reply: ${String(e)}`);
			dlog("reply.permission.reply.fail", { requestID, error: String(e) });
		}
	}

	return {
		ok: false,
		error: errors.join(" | "),
	};
}

type ReviewResult = {
	decision: Decision;
	reason?: string;
};

/** Tools the gate never reviews. Empty = review every `permission.asked`. */
const DEFAULT_SKIP: string[] = [];

/**
 * Default cooldown after operational failure (HTTP !ok, 429, timeout/abort,
 * missing key, empty body, unparsable + heuristic fail). Override via
 * agent-reviewer.json `tierCooldownMs`. In-memory only (cleared on restart).
 */
const DEFAULT_TIER_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * External config path: keys + tier/model settings live here, not in plugin source.
 * Override: env AGENT_REVIEWER_CONFIG=/path/to.json
 */
const DEFAULT_CONFIG_PATH = `${process.env.HOME ?? ""}/.config/kilo/agent-reviewer.json`;

/** No secrets in source — empty fallback if config file missing (fail-closed). */
const _FALLBACK_TIERS: TierConfig[] = [];

function configPath(): string {
	const fromEnv = process.env.AGENT_REVIEWER_CONFIG;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0)
		return fromEnv.trim();
	return DEFAULT_CONFIG_PATH;
}

function normalizeTier(raw: unknown, forcedName?: string): TierConfig | null {
	if (!raw || typeof raw !== "object") return null;
	const t = raw as Record<string, unknown>;
	const name =
		typeof forcedName === "string" && forcedName.length > 0
			? forcedName
			: typeof t.name === "string"
				? t.name
				: "";
	if (!name) return null;
	if (typeof t.baseURL !== "string" || t.baseURL.length === 0) return null;
	if (typeof t.model !== "string" || t.model.length === 0) return null;
	const out: TierConfig = {
		name,
		baseURL: t.baseURL,
		model: t.model,
	};
	if (typeof t.apiKey === "string" && t.apiKey.length > 0)
		out.apiKey = t.apiKey;
	if (typeof t.apiKeyEnv === "string" && t.apiKeyEnv.length > 0)
		out.apiKeyEnv = t.apiKeyEnv;
	if (typeof t.timeoutMs === "number" && t.timeoutMs > 0)
		out.timeoutMs = t.timeoutMs;
	if (typeof t.maxTokens === "number" && t.maxTokens > 0)
		out.maxTokens = t.maxTokens;
	if (typeof t.jsonObject === "boolean") out.jsonObject = t.jsonObject;
	if (
		t.apiFormat === "openai" ||
		t.apiFormat === "cohere-v2" ||
		t.apiFormat === "anthropic"
	)
		out.apiFormat = t.apiFormat;
	if (typeof t.thinkingBudget === "number" && t.thinkingBudget > 0)
		out.thinkingBudget = t.thinkingBudget;
	{
		const re =
			typeof t.reasoningEffort === "string"
				? t.reasoningEffort
				: typeof t.reasoning_effort === "string"
					? t.reasoning_effort
					: "";
		if (re.trim().length > 0) out.reasoningEffort = re.trim();
	}
	{
		const nested =
			typeof t.reasoning === "object" &&
			t.reasoning !== null &&
			!Array.isArray(t.reasoning)
				? (t.reasoning as Record<string, unknown>).max_tokens
				: undefined;
		const rmt =
			typeof t.reasoningMaxTokens === "number"
				? t.reasoningMaxTokens
				: typeof t.reasoning_max_tokens === "number"
					? t.reasoning_max_tokens
					: typeof nested === "number"
						? nested
						: 0;
		if (rmt > 0) out.reasoningMaxTokens = rmt;
	}
	if (Array.isArray(t.fallbackModels)) {
		const fb = t.fallbackModels
			.filter((m): m is string => typeof m === "string" && m.length > 0)
			.filter((m) => m !== out.model);
		if (fb.length) out.fallbackModels = fb;
	}
	if (
		typeof t.headers === "object" &&
		t.headers !== null &&
		!Array.isArray(t.headers)
	) {
		const h: Record<string, string> = {};
		for (const [k, v] of Object.entries(t.headers as Record<string, unknown>)) {
			if (typeof k === "string" && typeof v === "string") {
				const key = k.trim();
				const val = v.trim();
				if (key && val) h[key] = val;
			}
		}
		if (Object.keys(h).length > 0) out.headers = h;
	}
	return out;
}

/**
 * Build name → TierConfig map from file config.
 * Supports:
 *   - new:  tiers: { "cerebras": { baseURL, model, ... }, ... }
 *   - legacy: tiers: [ { name, baseURL, model, ... }, ... ]
 * Legacy `disabled: true` on array entries is ignored here; use `order`.
 */
function tiersMapFromConfig(cfg: FileConfig): Map<string, TierConfig> {
	const map = new Map<string, TierConfig>();
	const raw = cfg.tiers;
	if (!raw) return map;
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const t = normalizeTier(item);
			if (t) map.set(t.name, t);
		}
		return map;
	}
	if (typeof raw === "object") {
		for (const [name, item] of Object.entries(raw as Record<string, unknown>)) {
			const t = normalizeTier(item, name);
			if (t) map.set(t.name, t);
		}
	}
	return map;
}

/**
 * Resolve enabled chain:
 *   - if `order` is a non-empty array → that order (skip unknown names)
 *   - else if legacy tiers[] present → array order (skip disabled:true)
 *   - else → empty (fail-closed)
 */
function resolveOrder(
	cfg: FileConfig,
	map: Map<string, TierConfig>,
): { order: string[]; tiers: TierConfig[]; skipped: string[] } {
	const skipped: string[] = [];
	const rawOrder = cfg.order;
	if (Array.isArray(rawOrder) && rawOrder.length > 0) {
		const order: string[] = [];
		const tiers: TierConfig[] = [];
		for (const name of rawOrder) {
			if (typeof name !== "string" || !name) continue;
			const t = map.get(name);
			if (!t) {
				skipped.push(name);
				continue;
			}
			order.push(name);
			tiers.push(t);
		}
		return { order, tiers, skipped };
	}
	// Legacy: tiers was array — preserve insertion order, honor disabled
	if (Array.isArray(cfg.tiers)) {
		const order: string[] = [];
		const tiers: TierConfig[] = [];
		for (const item of cfg.tiers) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			if (rec.disabled === true) continue;
			const t = normalizeTier(item);
			if (!t) continue;
			order.push(t.name);
			tiers.push(t);
		}
		return { order, tiers, skipped };
	}
	return { order: [], tiers: [], skipped };
}

type LoadedFile = {
	cfg: FileConfig;
	path: string;
	mtimeMs: number;
};

/**
 * Sync load of agent-reviewer.json. Never throws.
 */
function readConfigFile(): LoadedFile {
	const path = configPath();
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		if (!fs.existsSync(path)) {
			dlog("config.missing", { path });
			return { cfg: {}, path, mtimeMs: 0 };
		}
		const st = fs.statSync(path);
		const raw = fs.readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			dlog("config.invalid_root", { path, type: typeof parsed });
			return { cfg: {}, path, mtimeMs: st.mtimeMs };
		}
		const cfg = parsed as FileConfig;
		const map = tiersMapFromConfig(cfg);
		const resolved = resolveOrder(cfg, map);
		dlog("config.loaded", {
			path,
			mtimeMs: st.mtimeMs,
			tierDefs: [...map.keys()],
			order: resolved.order,
			skipped: resolved.skipped,
			hasPrompt:
				typeof cfg.systemPrompt === "string" && cfg.systemPrompt.length > 0,
			hasCooldown: typeof cfg.tierCooldownMs === "number",
			skip: cfg.skip,
			cache: cfg.cache,
		});
		return { cfg, path, mtimeMs: st.mtimeMs };
	} catch (e) {
		dlog("config.load_error", { path, error: String(e) });
		return { cfg: {}, path, mtimeMs: 0 };
	}
}

function buildRuntime(
	file: LoadedFile,
	options?: ReviewerOptions,
): RuntimeConfig {
	// options overlay for non-file factory tests; order/tiers from options win if set
	const cfg: FileConfig = { ...file.cfg, ...(options ?? {}) };
	if (options?.tiers !== undefined) cfg.tiers = options.tiers;
	if (options?.order !== undefined) cfg.order = options.order;
	if (options?.systemPrompt !== undefined)
		cfg.systemPrompt = options.systemPrompt;

	const map = tiersMapFromConfig(cfg);
	const { order, tiers, skipped } = resolveOrder(cfg, map);
	if (skipped.length) {
		dlog("config.order_unknown", { skipped, known: [...map.keys()] });
	}

	const skip = Array.isArray(cfg.skip)
		? cfg.skip.map(String).filter((s) => s.length > 0)
		: [...DEFAULT_SKIP];

	const cache = cfg.cache !== false;
	const tierCooldownMs =
		typeof cfg.tierCooldownMs === "number" && cfg.tierCooldownMs > 0
			? cfg.tierCooldownMs
			: DEFAULT_TIER_COOLDOWN_MS;

	const systemPrompt =
		typeof cfg.systemPrompt === "string" && cfg.systemPrompt.trim().length > 0
			? cfg.systemPrompt.trim()
			: "";

	return {
		tiers,
		skip,
		cache,
		tierCooldownMs,
		systemPrompt,
		order,
		path: file.path,
		mtimeMs: file.mtimeMs,
	};
}

/** In-process file cache (mtime). Cleared only by process restart. */
let cachedFile: LoadedFile | null = null;
let cachedFileMtimeMs = -1;
let cachedFilePath = "";

/**
 * Sync read of config file, reloading when mtime changes.
 * Never throws.
 */
function getConfigFile(): LoadedFile {
	const path = configPath();
	let mtimeMs = 0;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		if (fs.existsSync(path)) mtimeMs = fs.statSync(path).mtimeMs;
	} catch {
		mtimeMs = 0;
	}

	if (
		cachedFile &&
		cachedFilePath === path &&
		cachedFileMtimeMs === mtimeMs &&
		mtimeMs > 0
	) {
		return cachedFile;
	}

	const file = readConfigFile();
	const prevMtime = cachedFileMtimeMs;
	cachedFile = file;
	cachedFileMtimeMs = file.mtimeMs > 0 ? file.mtimeMs : mtimeMs;
	cachedFilePath = file.path;
	if (prevMtime >= 0 && cachedFileMtimeMs !== prevMtime) {
		dlog("config.hot_reload", {
			path: file.path,
			mtimeMs: cachedFileMtimeMs,
			prevMtimeMs: prevMtime,
		});
	}
	return file;
}

/**
 * Resolve runtime config from (possibly cached) file + optional factory options.
 * Safe to call on every permission.asked.
 */
function getRuntimeConfig(options?: ReviewerOptions): RuntimeConfig {
	const file = getConfigFile();
	return buildRuntime(file, options);
}

/** @deprecated use getRuntimeConfig — kept name for any external references */
function _loadFileConfig(): FileConfig {
	return readConfigFile().cfg;
}

function resolveApiKey(tier: TierConfig): string | undefined {
	if (typeof tier.apiKey === "string" && tier.apiKey.length > 0)
		return tier.apiKey;
	if (typeof tier.apiKeyEnv === "string" && tier.apiKeyEnv.length > 0) {
		const v = process.env[tier.apiKeyEnv];
		if (v && v.length > 0) return v;
	}
	return undefined;
}

function stripCodeFences(text: string): string {
	let t = text.trim();
	if (t.startsWith("```")) {
		t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	}
	return t.trim();
}

/** Extract first balanced `{...}` JSON object from model output. */
function extractJsonObject(text: string): string | null {
	const cleaned = stripCodeFences(text);
	const start = cleaned.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let isEscaped = false;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (inString) {
			if (isEscaped) {
				isEscaped = false;
			} else if (ch === "\\") {
				isEscaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return cleaned.slice(start, i + 1);
		}
	}
	// Fallback: greedy first-brace regex
	const m = cleaned.match(/\{[\s\S]*\}/);
	return m ? m[0] : null;
}

function normalizeDecision(value: unknown): Decision | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (
		v === "approve" ||
		v === "allow" ||
		v === "yes" ||
		v === "ok" ||
		v === "safe"
	)
		return "approve";
	if (
		v === "escalate" ||
		v === "deny" ||
		v === "reject" ||
		v === "block" ||
		v === "ask" ||
		v === "human" ||
		v === "unsafe"
	) {
		return "escalate";
	}
	return null;
}

function parseDecision(raw: string): ReviewResult {
	const objText = extractJsonObject(raw);
	if (!objText) throw new Error("no JSON object in reviewer response");
	let parsed: unknown;
	try {
		parsed = JSON.parse(objText);
	} catch (e) {
		throw new Error(`JSON.parse failed: ${(e as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object")
		throw new Error("reviewer JSON not an object");
	const rec = parsed as Record<string, unknown>;
	const decision = normalizeDecision(rec.decision);
	if (!decision) {
		throw new Error(`invalid decision: ${String(rec.decision)}`);
	}
	const reason = typeof rec.reason === "string" ? rec.reason : undefined;
	return { decision, reason };
}

function buildUserMessage(req: {
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	enrichedArgs?: unknown;
}): string {
	const parts: string[] = [];
	parts.push(`permission: ${req.permission}`);
	if (req.patterns?.length)
		parts.push(`patterns: ${JSON.stringify(req.patterns)}`);
	const meta = req.metadata ?? {};
	if (typeof meta.command === "string") parts.push(`command: ${meta.command}`);
	if (meta.cwd != null) parts.push(`cwd: ${String(meta.cwd)}`);
	// Drop huge/noisy fields; keep a compact view of remaining metadata
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(meta)) {
		if (k === "command" || k === "cwd") continue;
		if (typeof v === "string" && v.length > 4000) {
			rest[k] = `${v.slice(0, 4000)}…(truncated)`;
		} else {
			rest[k] = v;
		}
	}
	if (Object.keys(rest).length) parts.push(`metadata: ${JSON.stringify(rest)}`);
	if (req.enrichedArgs !== undefined) {
		let argsStr: string;
		try {
			argsStr = JSON.stringify(req.enrichedArgs);
		} catch {
			argsStr = String(req.enrichedArgs);
		}
		if (argsStr.length > 12000)
			argsStr = `${argsStr.slice(0, 12000)}…(truncated)`;
		parts.push(`tool_args: ${argsStr}`);
	}
	return parts.join("\n");
}

function cacheKey(
	permission: string,
	patterns: string[],
	metadata: Record<string, unknown>,
	enriched?: unknown,
): string {
	try {
		return JSON.stringify({ permission, patterns, metadata, enriched });
	} catch {
		return `${permission}|${(patterns || []).join(",")}|${String(metadata?.command ?? "")}`;
	}
}

/** Pull assistant text from OpenAI-compatible + Anthropic + NIM reasoning-style + Cohere v2 payloads. */
function extractAssistantText(data: unknown): string {
	// Anthropic native: data.content[] with {type:"text", text}
	const anthropicContent = (data as { content?: unknown })?.content;
	if (Array.isArray(anthropicContent)) {
		const texts: string[] = [];
		for (const part of anthropicContent) {
			if (part && typeof part === "object") {
				const p = part as { type?: string; text?: string };
				if (typeof p.text === "string" && (p.type === "text" || !p.type)) {
					texts.push(p.text);
				}
			} else if (typeof part === "string") {
				texts.push(part);
			}
		}
		if (texts.length && texts.join("").trim()) return texts.join("");
	}

	// Cohere v2 native: data.message.content[] with {type:"text"|"thinking", text|thinking}
	const v2Msg = (data as { message?: { content?: unknown } })?.message;
	if (v2Msg && Array.isArray(v2Msg.content)) {
		const texts: string[] = [];
		for (const part of v2Msg.content) {
			if (part && typeof part === "object") {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") {
					texts.push(p.text);
				}
			}
		}
		if (texts.length) return texts.join("");
	}

	// OpenAI-compatible / NIM: choices[0].message
	const choices = (data as { choices?: unknown[] })?.choices;
	const choice0 = Array.isArray(choices) ? choices[0] : undefined;
	const msg =
		(choice0 as { message?: Record<string, unknown> } | undefined)?.message ??
		{};
	const candidates: unknown[] = [
		msg.content,
		msg.reasoning,
		msg.reasoning_content,
		(choice0 as { text?: unknown } | undefined)?.text,
	];
	for (const c of candidates) {
		if (typeof c === "string" && c.trim()) return c;
		// some providers return content as array of parts
		if (Array.isArray(c)) {
			const joined = c
				.map((p) => {
					if (typeof p === "string") return p;
					if (
						p &&
						typeof p === "object" &&
						typeof (p as { text?: string }).text === "string"
					) {
						return (p as { text: string }).text;
					}
					return "";
				})
				.join("");
			if (joined.trim()) return joined;
		}
	}
	return "";
}

/**
 * Last-resort: if the model only wrote free-form text, look for approve/escalate tokens.
 * Prefer structured JSON via parseDecision; this only runs when JSON is missing.
 */
function heuristicDecision(text: string): ReviewResult | null {
	const lower = text.toLowerCase();
	// Prefer explicit JSON-like decision= values if present
	const m = text.match(/"decision"\s*:\s*"(approve|escalate)"/i);
	if (m) {
		const reasonMatch = text.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/i);
		return {
			decision: m[1].toLowerCase() as Decision,
			reason: reasonMatch ? reasonMatch[1].slice(0, 200) : undefined,
		};
	}
	// If model clearly concludes escalate/approve in plain language near the end
	const tail = lower.slice(-400);
	if (
		/\b(decision\s*[:=]\s*)?escalate\b/.test(tail) &&
		!/\bapprove\b/.test(tail.slice(-80))
	) {
		return {
			decision: "escalate",
			reason: "heuristic: model text leaned escalate",
		};
	}
	if (
		/\b(decision\s*[:=]\s*)?approve\b/.test(tail) &&
		!/\bescalate\b/.test(tail.slice(-80))
	) {
		return {
			decision: "approve",
			reason: "heuristic: model text leaned approve",
		};
	}
	return null;
}

/**
 * Models to try for a tier: primary first, then fallbackModels.
 * Deduped, primary always first.
 */
function tierModels(tier: TierConfig): string[] {
	const out = [tier.model];
	for (const m of tier.fallbackModels || []) {
		if (m && m !== tier.model && !out.includes(m)) out.push(m);
	}
	return out;
}

/** NVIDIA Nemotron thinking models: disable chain-of-thought via /no_think marker. */
function isNemotronModel(model: string): boolean {
	return /nemotron/i.test(model || "");
}

/**
 * Official chat_template_kwargs.enable_thinking=false off-switch.
 * Nemotron 3 Super / 3.5 Lightning ignore `/no_think` (CoT stays on, finish=length).
 * Poolside Laguna S 2.1 documents the same kwargs on inference.poolside.ai.
 */
function disableThinkingKwargs(
	model: string,
): Record<string, unknown> | undefined {
	const m = (model || "").toLowerCase();
	if (/nemotron/i.test(m) || /laguna/i.test(m) || m.startsWith("poolside/")) {
		return { enable_thinking: false };
	}
	return undefined;
}

/**
 * For any Nemotron model (any provider), append `/no_think` to the system
 * message so thinking/reasoning budget is skipped. Idempotent.
 * Model-level switch (not NIM-only); safe no-op if already present.
 * Lightning 3.5 / Super 3 still need chat_template_kwargs (see call body).
 */
function messagesForModel(
	model: string,
	messages: { role: string; content: string }[],
): { role: string; content: string }[] {
	if (!isNemotronModel(model)) return messages;
	return messages.map((m) => {
		if (m.role !== "system") return m;
		const c = m.content ?? "";
		if (/(?:^|\n)\s*\/no_think\s*(?:\n|$)/i.test(c)) return m;
		return { ...m, content: `${c.replace(/\s+$/, "")}\n/no_think` };
	});
}

async function callReviewerOnce(
	tier: TierConfig,
	model: string,
	messages: { role: string; content: string }[],
	requestID?: string,
): Promise<ReviewResult> {
	const apiKey = resolveApiKey(tier);
	if (!apiKey) throw new Error(`missing api key for tier ${tier.name}`);

	const base = tier.baseURL.replace(/\/+$/, "");
	const isAnthropic = tier.apiFormat === "anthropic";
	const isCohereV2 = tier.apiFormat === "cohere-v2";
	const url = isAnthropic
		? `${base}/messages`
		: isCohereV2
			? `${base}/chat`
			: `${base}/chat/completions`;
	const timeoutMs =
		typeof tier.timeoutMs === "number" && tier.timeoutMs > 0
			? tier.timeoutMs
			: 8000;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const maxTok =
		typeof tier.maxTokens === "number" && tier.maxTokens > 0
			? tier.maxTokens
			: 512;
	const isGroq = tier.name === "groq" || tier.baseURL.includes("api.groq.com");
	// Cerebras gpt-oss wants max_completion_tokens only (not max_tokens).
	const isCerebrasGptOss =
		tier.baseURL.includes("cerebras.ai") && /gpt-oss/i.test(model);

	// Nemotron (NIM / Ollama / etc.): force /no_think so reasoning does not
	// consume max_tokens and leave content empty (finish=length).
	const outboundMessages = messagesForModel(model, messages);

	let body: Record<string, unknown>;
	if (isAnthropic) {
		const systemMsg = outboundMessages.find((m) => m.role === "system");
		const userMsgs = outboundMessages.filter((m) => m.role !== "system");
		body = {
			model,
			messages: userMsgs,
			max_tokens: maxTok,
			temperature: 0,
			...(systemMsg?.content ? { system: systemMsg.content } : {}),
		};
	} else {
		body = {
			model,
			messages: outboundMessages,
			temperature: 0,
		};
		if (isGroq || isCerebrasGptOss) {
			body.max_completion_tokens = maxTok;
		} else {
			// Reasoning models (Cohere default) spend tokens on chain-of-thought first.
			body.max_tokens = maxTok;
		}
		// Cohere v2: limit reasoning tokens via thinking budget.
		// Full disable (type=disabled / reasoning_effort=none) triggers server 422
		// INVALID_TOOL_GENERATION on prompts >~200 chars — budget is the only reliable way.
		if (
			isCohereV2 &&
			typeof tier.thinkingBudget === "number" &&
			tier.thinkingBudget > 0
		) {
			body.thinking = { type: "enabled", token_budget: tier.thinkingBudget };
		}
		// Only attach when explicitly requested — free gateway models often 400 on this.
		if (tier.jsonObject === true) {
			body.response_format = { type: "json_object" };
		}
		// Per-tier reasoning_effort (qwen3.6 none, gpt-oss low, …). Skip for Cohere v2.
		if (
			!isCohereV2 &&
			typeof tier.reasoningEffort === "string" &&
			tier.reasoningEffort.length > 0
		) {
			body.reasoning_effort = tier.reasoningEffort;
		}
		if (
			!isCohereV2 &&
			!isGroq &&
			typeof tier.reasoningMaxTokens === "number" &&
			tier.reasoningMaxTokens > 0
		) {
			body.reasoning = { max_tokens: tier.reasoningMaxTokens };
		}
		// Nemotron Super/Lightning + Poolside Laguna: official thinking off-switch.
		const thinkKw = disableThinkingKwargs(model);
		if (!isCohereV2 && thinkKw) {
			body.chat_template_kwargs = thinkKw;
		}
	}

	// dlog only — never app.log (may contain tool args / model text)
	dlog("tier.request", {
		requestID,
		tier: tier.name,
		model,
		apiFormat: isAnthropic ? "anthropic" : isCohereV2 ? "cohere-v2" : "openai",
		max_tokens: body.max_tokens ?? body.max_completion_tokens,
		thinkingBudget: isCohereV2 ? tier.thinkingBudget : undefined,
		reasoning_effort: body.reasoning_effort,
		reasoning_max_tokens: tier.reasoningMaxTokens,
		jsonObject: tier.jsonObject === true,
		noThink: isNemotronModel(model),
		enableThinking:
			isAnthropic || isCohereV2
				? undefined
				: !disableThinkingKwargs(model)
					? undefined
					: false,
		headerKeys: tier.headers ? Object.keys(tier.headers) : undefined,
	});

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(isAnthropic
					? {
							"x-api-key": apiKey,
							"anthropic-version": "2023-06-01",
						}
					: {
							Authorization: `Bearer ${apiKey}`,
							...(isCohereV2 ? { Accept: "application/json" } : {}),
						}),
				// Groq/Cloudflare: bare clients without UA can get 403 (error 1010).
				"User-Agent": "agent-reviewer/1.0 (+kilo-plugin)",
				...(tier.headers || {}),
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			throw new Error(
				`HTTP ${res.status} ${res.statusText}: ${errBody.slice(0, 300)}`,
			);
		}

		const data = await res.json();
		const content = extractAssistantText(data);
		if (!content.trim()) {
			throw new Error("empty reviewer content");
		}

		const finish = isAnthropic
			? (data as { stop_reason?: string }).stop_reason
			: isCohereV2
				? (data as { finish_reason?: string }).finish_reason
				: (data as { choices?: Array<{ finish_reason?: string }> })
						?.choices?.[0]?.finish_reason;
		// Head+tail each ≤400 so safeJson does not further clip either slice.
		dlog("tier.response", {
			requestID,
			tier: tier.name,
			model,
			text_head: content.slice(0, 400),
			text_tail: content.slice(-400),
			finish,
		});

		try {
			return parseDecision(content);
		} catch (parseErr) {
			const heur = heuristicDecision(content);
			if (heur) return heur;
			throw parseErr;
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Call tier.model, then each fallbackModels entry on operational failure.
 * Returns { result, model } so logs/attribution show the model that answered.
 * Throws only when every model in the chain fails.
 */
async function callReviewer(
	tier: TierConfig,
	messages: { role: string; content: string }[],
	requestID?: string,
): Promise<ReviewResult & { model: string }> {
	const models = tierModels(tier);
	let lastErr: unknown;
	for (let i = 0; i < models.length; i++) {
		const model = models[i];
		try {
			const result = await callReviewerOnce(tier, model, messages, requestID);
			if (i > 0) {
				dlog("tier.model_fallback_ok", {
					requestID,
					tier: tier.name,
					from: models[0],
					model,
					decision: result.decision,
				});
			}
			return { ...result, model };
		} catch (err) {
			lastErr = err;
			const more = i < models.length - 1;
			dlog("tier.model_fail", {
				requestID,
				tier: tier.name,
				model,
				error: err instanceof Error ? err.message : String(err),
				nextModel: more ? models[i + 1] : undefined,
			});
			if (!more) break;
			// try next fallback model on same tier (no cooldown yet)
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(String(lastErr ?? "all models failed"));
}

/**
 * Logging helper.
 *
 * CRITICAL: must NEVER block plugin factory / event registration.
 * `client.app.log` is HTTP; if it hangs, `await log(...)` at factory top
 * would prevent hooks from being returned → gate dead while module imported.
 */
function log(
	client: PluginInput["client"] | undefined,
	level: "debug" | "info" | "warn" | "error",
	message: string,
	extra?: Record<string, unknown>,
) {
	dlog(`log.${level}`, { message, ...extra });
	if (!client?.app?.log) return;
	// hey-api SDK expects { body: { service, level, message, extra } }
	// Flat args produce schema rejection: "Expected object, got undefined"
	void Promise.resolve()
		.then(() =>
			// support both shapes — safe: guarded by `if (!client?.app?.log) return` above
			// biome-ignore lint/style/noNonNullAssertion: guarded by early-return check
			(client.app!.log as (p: unknown) => Promise<unknown>)({
				body: {
					service: "agent-reviewer",
					level,
					message,
					extra,
				},
			}),
		)
		.catch((e) => {
			dlog("log.app_failed", { message, error: String(e) });
		});
}

export const AgentReviewerPlugin = async (
	input: PluginInput,
	options?: ReviewerOptions,
) => {
	const t0 = Date.now();
	const clientKeys = input?.client ? Object.keys(input.client as object) : [];
	const protoKeys =
		input?.client && typeof input.client === "object"
			? Object.getOwnPropertyNames(
					Object.getPrototypeOf(input.client) ?? {},
				).filter((k) => k !== "constructor")
			: [];
	dlog("factory.enter", {
		directory: (input as { directory?: string })?.directory,
		worktree: (input as { worktree?: string })?.worktree,
		hasClient: Boolean(input?.client),
		hasAppLog: typeof input?.client?.app?.log === "function",
		hasPermReply: typeof input?.client?.permission?.reply === "function",
		hasPostSessionPerm:
			typeof (input?.client as KiloClient)
				?.postSessionIdPermissionsPermissionId === "function",
		clientKeys,
		protoKeys,
		optionsKeys: options ? Object.keys(options) : [],
	});

	const { client } = input;
	const pluginDirectory = (input as { directory?: string })?.directory;

	// Factory options (if any) overlay file config for the whole process.
	// File itself hot-reloads by mtime on every getRuntimeConfig() call.
	const factoryOptions = options;
	const boot = getRuntimeConfig(factoryOptions);

	const inFlight = new Set<string>();
	/** callID → tool args captured in tool.execute.before */
	const argsByCallID = new Map<
		string,
		{ tool: string; args: unknown; at: number }
	>();
	/** decision cache for identical approve paths */
	const decisionCache = new Map<string, ReviewResult>();
	/** Track consecutive timeouts per tier to delay cooldowns */
	const tierConsecutiveTimeouts = new Map<string, number>();
	/**
	 * Per-tier operational cooldown (key = tier.name).
	 * Set on throw from callReviewer; cleared when untilMs elapses.
	 * Survives config hot-reload (in-memory).
	 */
	const tierCooldown = new Map<
		string,
		{ untilMs: number; error: string; failedAt: number }
	>();
	/** Positive in-flight HTTP counts per tier.name (least-connections). */
	const activeConnections = new Map<string, number>();

	const isTierCooling = (
		name: string,
	):
		| { cooling: true; remainMs: number; error: string }
		| { cooling: false } => {
		const entry = tierCooldown.get(name);
		if (!entry) return { cooling: false };
		const remainMs = entry.untilMs - Date.now();
		if (remainMs <= 0) {
			tierCooldown.delete(name);
			return { cooling: false };
		}
		return { cooling: true, remainMs, error: entry.error };
	};

	const coolingNames = (list: readonly { name: string }[]): Set<string> => {
		const out = new Set<string>();
		for (const t of list) {
			if (isTierCooling(t.name).cooling) out.add(t.name);
		}
		return out;
	};

	const pickTier = (
		list: readonly TierConfig[],
		attempted: ReadonlySet<string>,
	): TierConfig | null =>
		selectLeastConnections(
			list,
			activeConnections,
			attempted,
			coolingNames(list),
		);

	const markTierCooldown = (name: string, err: unknown, cooldownMs: number) => {
		const error = err instanceof Error ? err.message : String(err);
		const failedAt = Date.now();
		const untilMs = failedAt + cooldownMs;
		tierCooldown.set(name, { untilMs, error: error.slice(0, 300), failedAt });
		dlog("tier.cooldown", {
			tier: name,
			untilMs,
			cooldownMs,
			error: error.slice(0, 300),
		});
	};

	// Bound memory: prune old arg entries (> 5 min) occasionally
	const pruneArgs = () => {
		const cutoff = Date.now() - 5 * 60 * 1000;
		for (const [k, v] of argsByCallID) {
			if (v.at < cutoff) argsByCallID.delete(k);
		}
		if (decisionCache.size > 500) {
			// drop oldest half by re-creating (Map preserves insertion order)
			let i = 0;
			const drop = Math.floor(decisionCache.size / 2);
			for (const k of decisionCache.keys()) {
				decisionCache.delete(k);
				if (++i >= drop) break;
			}
		}
	};

	// Drop stale / legacy IPC. Do not wipe live per-session files for other tabs.
	pruneStalePendingFiles();

	// MUST NOT await client.app.log here — blocks hook registration (bV4 awaits factory).
	log(client, "info", "plugin loaded", {
		version: PLUGIN_VERSION,
		order: boot.order,
		tiers: boot.tiers.map((t) => t.name),
		skip: boot.skip,
		cache: boot.cache,
		cooldownMs: boot.tierCooldownMs,
		promptChars: boot.systemPrompt.length,
		configPath: boot.path,
		directory: (input as { directory?: string })?.directory,
		ms: Date.now() - t0,
	});
	dlog("factory.hooks_ready", {
		version: PLUGIN_VERSION,
		order: boot.order,
		tiers: boot.tiers.map((t) => t.name),
		tierKeys: boot.tiers.map((t) => ({
			name: t.name,
			model: t.model,
			hasApiKey: Boolean(t.apiKey),
			apiKeyEnv: t.apiKeyEnv ?? null,
		})),
		skip: boot.skip,
		cooldownMs: boot.tierCooldownMs,
		promptChars: boot.systemPrompt.length,
		configPath: boot.path,
		ms: Date.now() - t0,
	});

	return {
		"tool.execute.before": async (beforeInput, output) => {
			try {
				dlog("hook.tool.execute.before", {
					tool: beforeInput?.tool,
					callID: beforeInput?.callID,
				});
				if (beforeInput?.callID) {
					argsByCallID.set(beforeInput.callID, {
						tool: beforeInput.tool,
						args: output?.args,
						at: Date.now(),
					});
				}
				if (argsByCallID.size > 200) pruneArgs();
			} catch (e) {
				dlog("hook.tool.execute.before.error", { error: String(e) });
			}
		},

		event: async ({ event }) => {
			try {
				if (!event || typeof event !== "object") {
					dlog("event.skip", { reason: "not-object" });
					return;
				}
				const type = (event as { type?: string }).type;
				// Always record permission.* and a sample of other events
				if (
					type?.startsWith("permission.") ||
					type === "session.idle" ||
					type === "message.updated"
				) {
					dlog("event", {
						type,
						keys: Object.keys(event as object),
						propsKeys: Object.keys(
							((event as { properties?: object }).properties ?? {}) as object,
						),
					});
				}

				if (type === "permission.replied") {
					const props = (
						event as {
							properties?: { requestID?: string; sessionID?: string };
						}
					).properties;
					if (props?.requestID) {
						inFlight.delete(props.requestID);
						repliedRequestIDs.add(props.requestID);
						if (repliedRequestIDs.size > 200) {
							const first = repliedRequestIDs.values().next().value;
							if (first) repliedRequestIDs.delete(first);
						}
					}
					clearPendingEscalate({
						requestID: props?.requestID,
						sessionID: props?.sessionID,
					});
					dlog("event.permission.replied", {
						requestID: props?.requestID,
						sessionID: props?.sessionID,
					});
					return;
				}

				if (type !== "permission.asked") return;

				const req = (
					event as {
						properties?: {
							id?: string;
							sessionID?: string;
							permission?: string;
							patterns?: string[];
							metadata?: Record<string, unknown>;
							tool?: { messageID?: string; callID?: string };
						};
					}
				).properties;

				// Hot-reload: re-read config if mtime changed (order / tiers / prompt).
				const rt = getRuntimeConfig(factoryOptions);
				const skip = new Set(rt.skip);
				const useCache = rt.cache;
				const tiers = rt.tiers;
				const TIER_COOLDOWN_MS = rt.tierCooldownMs;
				const systemPrompt = rt.systemPrompt;

				dlog("event.permission.asked", {
					id: req?.id,
					permission: req?.permission,
					patterns: req?.patterns,
					hasTool: Boolean(req?.tool),
					skipped: req?.permission ? skip.has(req.permission) : false,
					order: rt.order,
					configMtimeMs: rt.mtimeMs,
				});

				if (!req?.id || !req.permission) {
					dlog("event.permission.asked.skip", {
						reason: "missing id/permission",
						req,
					});
					return;
				}
				if (skip.has(req.permission)) {
					dlog("event.permission.asked.skip", {
						reason: "skip-list",
						permission: req.permission,
					});
					return;
				}
				if (inFlight.has(req.id)) {
					dlog("event.permission.asked.skip", {
						reason: "in-flight",
						id: req.id,
					});
					return;
				}
				inFlight.add(req.id);

				const requestID = req.id;
				const permission = req.permission;
				const patterns = Array.isArray(req.patterns) ? req.patterns : [];
				const metadata = (
					req.metadata && typeof req.metadata === "object" ? req.metadata : {}
				) as Record<string, unknown>;

				const overlayBase = {
					requestID,
					sessionID: req.sessionID,
					permission,
					command:
						typeof metadata.command === "string" ? metadata.command : undefined,
				};

				if (!systemPrompt) {
					log(
						client,
						"warn",
						"systemPrompt missing in agent-reviewer.json; fail-closed escalate to human",
						{
							requestID,
							permission,
						},
					);
					dlog("review.no_system_prompt", {
						requestID,
						permission,
						reason: "systemPrompt missing in config (fail-closed escalate)",
					});
					writePendingEscalate({
						...overlayBase,
						reason: "gate config error: systemPrompt missing",
						at: Date.now(),
					});
					return;
				}

				const firstLive = pickTier(tiers, new Set());
				writePendingEscalate({
					...overlayBase,
					reason: "gate reviewing…",
					tier: firstLive?.name,
					model: firstLive ? tierModels(firstLive)[0] : undefined,
					at: Date.now(),
				});

				let enrichedArgs: unknown;
				const callID = req.tool?.callID;
				if (callID && argsByCallID.has(callID)) {
					enrichedArgs = argsByCallID.get(callID)?.args;
				}

				const key = useCache
					? cacheKey(permission, patterns, metadata, enrichedArgs)
					: "";
				if (useCache && key && decisionCache.has(key)) {
					const cached = decisionCache.get(key) ?? {
						decision: "escalate" as const,
					};
					log(client, "info", "cache hit", {
						requestID,
						permission,
						decision: cached.decision,
					});
					if (cached.decision === "approve") {
						dlog("reply.cache", { requestID, sessionID: req.sessionID });
						const r = await replyPermission(client, {
							requestID,
							sessionID: req.sessionID,
							reply: "once",
							directory: pluginDirectory,
						});
						dlog(r.ok ? "reply.cache.ok" : "reply.cache.fail", r);
						if (!r.ok) {
							log(client, "debug", "reply after cache failed", {
								requestID,
								error: r.error,
							});
						}
					} else {
						const reason =
							cached.reason || "cached escalate (same payload as earlier gate)";
						writePendingEscalate({
							requestID,
							sessionID: req.sessionID,
							permission,
							command:
								typeof metadata.command === "string"
									? metadata.command
									: undefined,
							reason,
							at: Date.now(),
						});
					}
					inFlight.delete(requestID);
					return;
				}

				if (!tiers.length) {
					log(client, "warn", "no tiers configured; escalating to human", {
						requestID,
					});
					writePendingEscalate({
						requestID,
						sessionID: req.sessionID,
						permission,
						command:
							typeof metadata.command === "string"
								? metadata.command
								: undefined,
						reason: "no reviewer tiers configured",
						at: Date.now(),
					});
					inFlight.delete(requestID);
					return;
				}

				const userContent = buildUserMessage({
					permission,
					patterns,
					metadata,
					enrichedArgs,
				});
				const messages = [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userContent },
				];

				log(client, "info", "review start", {
					requestID,
					permission,
					patterns,
					command:
						typeof metadata.command === "string" ? metadata.command : undefined,
					order: rt.order,
					tiers: tiers.map((t) => t.name),
				});
				// userContent is dlog-only (may include diffs/commands); never app.log
				dlog("review.start", {
					requestID,
					permission,
					patterns: patterns.slice(0, 3),
					userContent,
				});

				try {
					const attempted = new Set<string>();
					const cooldownLogged = new Set<string>();
					while (true) {
						for (const t of tiers) {
							if (attempted.has(t.name) || cooldownLogged.has(t.name)) continue;
							const cool = isTierCooling(t.name);
							if (!cool.cooling) continue;
							cooldownLogged.add(t.name);
							const remainSec = Math.ceil(cool.remainMs / 1000);
							log(client, "info", "tier cooldown skip; next tier", {
								requestID,
								tier: t.name,
								model: t.model,
								remainSec,
								lastError: cool.error,
							});
							dlog("tier.skip_cooldown", {
								requestID,
								tier: t.name,
								model: t.model,
								remainMs: cool.remainMs,
								remainSec,
								lastError: cool.error,
							});
						}

						const tier = pickTier(tiers, attempted);
						if (!tier) break;
						attempted.add(tier.name);

						const counts = activeCountSnapshot(tiers, activeConnections);
						dlog("tier.select", {
							requestID,
							tier: tier.name,
							active: activeConnections.get(tier.name) ?? 0,
							activeCounts: counts,
						});

						try {
							const models = tierModels(tier);
							dlog("tier.call", {
								requestID,
								tier: tier.name,
								model: models[0],
								fallbackModels: models.slice(1),
								active: activeConnections.get(tier.name) ?? 0,
								activeCounts: counts,
							});
							writePendingEscalate({
								...overlayBase,
								reason: "gate reviewing…",
								tier: tier.name,
								model: models[0],
								at: Date.now(),
							});
							const result = await withTierConnection(
								activeConnections,
								tier.name,
								() => callReviewer(tier, messages, requestID),
							);
							const usedModel = result.model || tier.model;
							tierConsecutiveTimeouts.delete(tier.name);
							log(client, "info", "tier result", {
								requestID,
								tier: tier.name,
								model: usedModel,
								decision: result.decision,
								reason: result.reason,
								active: activeConnections.get(tier.name) ?? 0,
							});
							dlog("tier.result", {
								requestID,
								tier: tier.name,
								model: usedModel,
								decision: result.decision,
								reason: result.reason,
								active: activeConnections.get(tier.name) ?? 0,
							});

							if (result.decision === "approve") {
								if (useCache && key) decisionCache.set(key, result);
								dlog("reply.approve", {
									requestID,
									sessionID: req.sessionID,
									tier: tier.name,
									model: usedModel,
								});
								const r = await replyPermission(client, {
									requestID,
									sessionID: req.sessionID,
									reply: "once",
									directory: pluginDirectory,
								});
								dlog(r.ok ? "reply.approve.ok" : "reply.approve.fail", {
									...r,
									requestID,
									tier: tier.name,
									model: usedModel,
								});
								if (!r.ok) {
									log(client, "warn", "reply failed", {
										requestID,
										tier: tier.name,
										model: usedModel,
										error: r.error,
									});
								}
								return;
							}

							// definitive escalate — do not fall through tiers
							if (useCache && key) decisionCache.set(key, result);
							log(client, "info", "escalating to human", {
								requestID,
								tier: tier.name,
								model: usedModel,
								reason: result.reason,
							});
							dlog("escalate", {
								requestID,
								tier: tier.name,
								model: usedModel,
								reason: result.reason,
							});
							{
								const reason =
									result.reason || "reviewer escalated (no reason)";
								writePendingEscalate({
									requestID,
									sessionID: req.sessionID,
									permission,
									command:
										typeof metadata.command === "string"
											? metadata.command
											: undefined,
									reason,
									tier: tier.name,
									model: usedModel,
									at: Date.now(),
								});
							}
							return;
						} catch (err) {
							const isTimeout =
								err instanceof Error && err.name === "AbortError";
							let appliedCooldownMs = TIER_COOLDOWN_MS;

							if (isTimeout) {
								const count = (tierConsecutiveTimeouts.get(tier.name) || 0) + 1;
								tierConsecutiveTimeouts.set(tier.name, count);
								if (count >= 3) {
									markTierCooldown(tier.name, err, TIER_COOLDOWN_MS);
									tierConsecutiveTimeouts.delete(tier.name);
								} else {
									appliedCooldownMs = 0;
								}
							} else {
								tierConsecutiveTimeouts.delete(tier.name);
								markTierCooldown(tier.name, err, TIER_COOLDOWN_MS);
							}

							log(client, "warn", "tier operational failure; next tier", {
								requestID,
								tier: tier.name,
								model: tier.model,
								fallbackModels: tier.fallbackModels,
								error: err instanceof Error ? err.message : String(err),
								isTimeout,
								consecutiveTimeouts: isTimeout
									? tierConsecutiveTimeouts.get(tier.name) || 0
									: 0,
								cooldownMs: appliedCooldownMs,
								active: activeConnections.get(tier.name) ?? 0,
							});
							dlog("tier.fail", {
								requestID,
								tier: tier.name,
								model: tier.model,
								fallbackModels: tier.fallbackModels,
								error: err instanceof Error ? err.message : String(err),
								isTimeout,
								consecutiveTimeouts: isTimeout
									? tierConsecutiveTimeouts.get(tier.name) || 0
									: 0,
								cooldownMs: appliedCooldownMs,
								active: activeConnections.get(tier.name) ?? 0,
							});
							// continue: select again among remaining tiers
						}
					}

					log(
						client,
						"error",
						"all tiers failed; fail-closed escalate to human",
						{
							requestID,
							permission,
						},
					);
					dlog("all_tiers_failed", { requestID, permission });
					writePendingEscalate({
						requestID,
						sessionID: req.sessionID,
						permission,
						command:
							typeof metadata.command === "string"
								? metadata.command
								: undefined,
						reason: "all reviewer tiers failed (fail-closed)",
						at: Date.now(),
					});
				} finally {
					inFlight.delete(requestID);
				}
			} catch (e) {
				dlog("event.unhandled_error", { error: String(e) });
			}
		},
	};
};

// Default export for Kilo plugin loader (file:// and auto-discovered plugins)
export default AgentReviewerPlugin;
