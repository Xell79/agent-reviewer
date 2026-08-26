/**
 * TUI half of agent-reviewer: on gate escalate, show the reviewer reason
 * only in the Kilo session that owns the permission request.
 *
 * Permit / Reject stay on the native permission dialog (do NOT dialog.replace).
 * The native prompt covers the `app` layer, so the reason is also a toast
 * and a sidebar_title line — those sit in chrome the dialog does not eat.
 *
 * Loaded via ~/.config/kilo/tui.jsonc — NOT via plugin/ auto-scan.
 *
 * IPC: ~/.local/share/kilo/log/agent-reviewer/pending/<sessionID>.json
 */
/** @jsxImportSource @opentui/solid */
import fs from "node:fs";
import { createSignal, Show } from "solid-js";
import type { TuiPlugin, TuiPluginApi } from "@kilocode/plugin/tui";

const LOG_DIR =
	process.env.AGENT_REVIEWER_LOG_DIR ||
	`${process.env.XDG_DATA_HOME || `${process.env.HOME ?? ""}/.local/share`}/kilo/log/agent-reviewer`;
const PENDING_DIR = `${LOG_DIR}/pending`;
const PENDING_LEGACY = `${LOG_DIR}/pending-escalate.json`;
const TUI_LOG = `${LOG_DIR}/tui.log`;
const POLL_MS = 250;
const STALE_MS = 5 * 60 * 1000;

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

function tlog(msg: string, extra?: unknown): void {
	try {
		const line = `${new Date().toISOString()} ${msg}${
			extra === undefined ? "" : ` ${JSON.stringify(extra)}`
		}\n`;
		fs.appendFileSync(TUI_LOG, line);
	} catch {
		// ignore
	}
}

function sessionFileId(sessionID: string | undefined): string | null {
	if (!sessionID) return null;
	if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) return null;
	return sessionID;
}

function pendingPath(sessionID: string): string {
	return `${PENDING_DIR}/${sessionID}.json`;
}

function currentSessionID(api: TuiPluginApi): string | undefined {
	const route = api.route.current;
	if (route.name === "session") {
		const id = route.params?.sessionID;
		if (typeof id === "string" && id) return id;
	}
	return undefined;
}

function unlinkIfExists(file: string): void {
	try {
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch {
		// ignore
	}
}

function readSessionPending(
	sessionID: string,
	replied: Set<string>,
): PendingEscalate | null {
	const file = pendingPath(sessionID);
	try {
		if (!fs.existsSync(file)) return null;
		const raw = fs.readFileSync(file, "utf8").trim();
		if (!raw) {
			unlinkIfExists(file);
			return null;
		}
		const p = JSON.parse(raw) as PendingEscalate;
		if (!p || typeof p.requestID !== "string" || !p.requestID) {
			unlinkIfExists(file);
			return null;
		}
		if (p.sessionID && p.sessionID !== sessionID) {
			tlog("pending.drop_foreign_session", {
				fileSession: p.sessionID,
				viewSession: sessionID,
			});
			unlinkIfExists(file);
			return null;
		}
		if (replied.has(p.requestID)) {
			unlinkIfExists(file);
			return null;
		}
		if (typeof p.at === "number" && Date.now() - p.at > STALE_MS) {
			tlog("pending.drop_stale", { requestID: p.requestID, sessionID });
			unlinkIfExists(file);
			return null;
		}
		return { ...p, sessionID };
	} catch {
		unlinkIfExists(file);
		return null;
	}
}

function ink(theme: Record<string, unknown>, key: string, fallback: string): string {
	const v = theme[key];
	return typeof v === "string" && v ? v : fallback;
}

const REVIEWING = "gate reviewing…";

function reasonText(p: PendingEscalate | null): string {
	return (p?.reason || REVIEWING).trim().slice(0, 400);
}

function modelLabel(p: PendingEscalate | null): string {
	const tier = p?.tier?.trim();
	if (tier) return tier;
	const model = p?.model?.trim();
	return model || "gate";
}

function overlayTitle(p: PendingEscalate | null): string {
	const reviewing = (p?.reason || "") === REVIEWING;
	return reviewing
		? `Gate reviewing · ${modelLabel(p)}`
		: `Gate escalate · ${modelLabel(p)}`;
}

const tui: TuiPlugin = async (api) => {
	const replied = new Set<string>();
	const toasted = new Set<string>();
	tlog("tui.enter", {
		pendingDir: PENDING_DIR,
		route: api.route.current,
	});
	const [pending, setPending] = createSignal<PendingEscalate | null>(null);

	const hideLocal = (): void => {
		if (pending()) setPending(null);
	};

	const tick = (): void => {
		const sid = currentSessionID(api);
		const cur = pending();
		if (!sid) {
			if (cur) hideLocal();
			return;
		}
		const p = readSessionPending(sid, replied);
		if (!p) {
			if (cur) hideLocal();
			return;
		}
		if (
			cur &&
			cur.requestID === p.requestID &&
			cur.reason === p.reason &&
			cur.model === p.model &&
			cur.tier === p.tier
		) {
			return;
		}
		setPending(p);
		const reviewing = p.reason === REVIEWING;
		tlog("pending.show", {
			requestID: p.requestID,
			sessionID: sid,
			reason: p.reason,
			model: p.model,
			tier: p.tier,
			reviewing,
			route: api.route.current,
		});
		if (!reviewing && !toasted.has(p.requestID)) {
			toasted.add(p.requestID);
			try {
				api.ui.toast({
					variant: "warning",
					title: overlayTitle(p),
					message: reasonText(p),
					duration: 30_000,
				});
			} catch (e) {
				tlog("toast.fail", String(e));
			}
		}
	};

	api.slots.register({
		slots: {
			// Read the signal inside the slot so the host tracking scope re-renders.
			app() {
				const p = pending();
				const theme = api.theme.current as Record<string, unknown>;
				return (
					<Show when={p}>
						<box
							position="absolute"
							zIndex={9000}
							top={0}
							left={0}
							width="100%"
							height={4}
							justifyContent="center"
							alignItems="center"
						>
							<box
								border
								borderColor={ink(theme, "warning", "#ffb020")}
								backgroundColor={ink(theme, "backgroundPanel", "#1d1d1d")}
								paddingLeft={2}
								paddingRight={2}
								width={78}
								flexDirection="column"
							>
								<text fg={ink(theme, "warning", "#ffb020")}>
									{overlayTitle(p)}
								</text>
								<text fg={ink(theme, "text", "#f0f0f0")}>{reasonText(p)}</text>
							</box>
						</box>
					</Show>
				);
			},
			sidebar_title(props: { session_id: string; title: string }) {
				const p = pending();
				if (!p || p.sessionID !== props.session_id) return null;
				const theme = api.theme.current as Record<string, unknown>;
				return (
					<text fg={ink(theme, "warning", "#ffb020")}>
						{` · ${overlayTitle(p)}`}
					</text>
				);
			},
		},
	});

	unlinkIfExists(PENDING_LEGACY);

	tick();
	const id = setInterval(tick, POLL_MS);

	const offReplied = api.event.on("permission.replied", (ev) => {
		const props = ev.properties;
		const rid = props.requestID;
		const sid = props.sessionID;
		tlog("permission.replied", { requestID: rid, sessionID: sid });
		if (rid) {
			replied.add(rid);
			if (replied.size > 200) {
				const first = replied.values().next().value;
				if (first) replied.delete(first);
			}
		}
		const fileSid = sessionFileId(sid);
		if (fileSid) {
			try {
				const file = pendingPath(fileSid);
				if (fs.existsSync(file)) {
					const p = JSON.parse(fs.readFileSync(file, "utf8")) as PendingEscalate;
					if (!rid || p.requestID === rid) unlinkIfExists(file);
				}
			} catch {
				unlinkIfExists(pendingPath(fileSid));
			}
		}
		const cur = pending();
		if (!cur) return;
		if (rid && cur.requestID === rid) hideLocal();
		else if (sid && cur.sessionID === sid && (!rid || cur.requestID === rid)) {
			hideLocal();
		}
	});

	api.lifecycle.onDispose(() => {
		clearInterval(id);
		offReplied();
		tlog("tui.dispose");
	});
	tlog("tui.ready");
};

export default { id: "agent-reviewer-tui", tui };
