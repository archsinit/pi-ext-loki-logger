/**
 * Loki logger extension.
 * Zones: pi agent, logging, storage
 * Logs Pi session events to per-session JSONL locally and pushes truncated entries to Loki.
 *
 * Local logs: full raw payload.
 * Loki logs: truncated raw only. No complete raw payload.
 */

import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "telegram";
const SUMMARY_LIMIT = 50;
const LOKI_RAW_LIMIT = 50;
const LOCAL_DIR = join(homedir(), ".pi", "logs", "loki-sessions");
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "loki-logger.json");
const KEEP_SESSIONS = 50;

type LokiConfig = {
	url: string;
	authToken: string;
	userId: string;
};

type LogShape = {
	ts: string;
	session_id: string;
	channel: string;
	model: string;
	event_type: string;
	role: string;
	raw: string;
	summary: string;
	chars: number;
	truncated: boolean;
};

function ensureDir(path: string) {
	mkdirSync(path, { recursive: true });
}

function ensurePrivateDir(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	try {
		chmodSync(path, 0o700);
	} catch {
		// ignore
	}
}


function readConfig(): LokiConfig | undefined {
	if (!existsSync(CONFIG_FILE)) return undefined;

	try {
		const data = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<LokiConfig>;
		if (!data.url || !data.authToken || !data.userId) return undefined;

		return {
			url: data.url,
			authToken: data.authToken,
			userId: data.userId,
		};
	} catch {
		return undefined;
	}
}

function writeConfig(config: LokiConfig) {
	ensurePrivateDir(CONFIG_DIR);

	const tmpFile = join(CONFIG_DIR, `.loki-logger.${Date.now()}.tmp`);
	writeFileSync(tmpFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmpFile, CONFIG_FILE);

	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		// ignore
	}
}

function cleanKeepNewestSessions() {
	ensurePrivateDir(LOCAL_DIR);

	const files = readdirSync(LOCAL_DIR)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => {
			try {
				const file = join(LOCAL_DIR, name);
				return [{ file, mtimeMs: statSync(file).mtimeMs }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const stale of files.slice(KEEP_SESSIONS)) {
		try {
			unlinkSync(stale.file);
		} catch {
			// ignore
		}
	}
}

function safeJson(value: unknown): string {
	if (typeof value === "string") return value;

	try {
		return JSON.stringify(value, (_key, current) => {
			if (typeof current === "bigint") return current.toString();

			if (current instanceof Error) {
				return {
					name: current.name,
					message: current.message,
					stack: current.stack,
				};
			}

			return current;
		});
	} catch {
		return String(value);
	}
}

function summarize(raw: string): string {
	return raw.replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
}

function nowIso() {
	return new Date().toISOString();
}

function nowNs(): string {
	return `${BigInt(Date.now()) * 1_000_000n}`;
}

function getModelId(ctx: { getModel: () => { id?: string } | undefined }): string {
	return ctx.getModel()?.id ?? "unknown";
}

function messageEventTypeForRole(role: string | undefined): string {
	const value = String(role ?? "system");
	if (value === "assistant") return "output";
	if (value === "user") return "input";
	if (value.toLowerCase().includes("tool")) return "tool_result";
	return "system";
}

function toLokiEntry(entry: LogShape): LogShape {
	const truncatedRaw = entry.raw.slice(0, LOKI_RAW_LIMIT);

	return {
		...entry,
		raw: truncatedRaw,
		summary: truncatedRaw.replace(/\s+/g, " "),
		chars: entry.raw.length,
		truncated: entry.raw.length > LOKI_RAW_LIMIT,
	};
}

async function pushToLoki(config: LokiConfig, entry: LogShape) {
	const lokiEntry = toLokiEntry(entry);

	const body = {
		streams: [
			{
				stream: {
					app: "pi",
					channel: lokiEntry.channel,
					event_type: lokiEntry.event_type,
					role: lokiEntry.role,
					model: lokiEntry.model,
				},
				values: [[nowNs(), JSON.stringify(lokiEntry)]],
			},
		],
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Basic ${Buffer.from(`${config.userId}:${config.authToken}`).toString("base64")}`,
	};

	const res = await fetch(config.url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`Loki push failed: ${res.status} ${res.statusText}`);
	}
}

function appendLocal(sessionId: string, entry: LogShape) {
	ensurePrivateDir(LOCAL_DIR);

	const file = join(LOCAL_DIR, `${sessionId}.jsonl`);

	appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function logEvent(
	ctx: {
		getModel: () => { id?: string } | undefined;
		sessionManager: { getSessionId: () => string };
	},
	eventType: string,
	role: string,
	payload: unknown,
) {
	const config = readConfig();
	const sessionId = ctx.sessionManager.getSessionId();
	const raw = safeJson(payload);

	const entry: LogShape = {
		ts: nowIso(),
		session_id: sessionId,
		channel: CHANNEL,
		model: getModelId(ctx),
		event_type: eventType,
		role,
		raw,
		summary: summarize(raw),
		chars: raw.length,
		truncated: raw.length > SUMMARY_LIMIT,
	};

	appendLocal(sessionId, entry);

	if (config) {
		void pushToLoki(config, entry).catch(() => {});
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("loki-setup", {
		description: "Configure Loki logging (usage: /loki-setup)",
		handler: async (_args, ctx) => {
			const current = readConfig();

			const urlInput = (
				await ctx.ui.input(
					"Loki push URL",
					current?.url ?? "https://loki.example.com/loki/api/v1/push",
				)
			)?.trim();

			const authInput = (await ctx.ui.input("Auth token", ""))?.trim();

			const userInput = (
				await ctx.ui.input(
					"Tenant / user ID",
					current?.userId ?? "tenant or user id",
				)
			)?.trim();

			const url = urlInput || current?.url;
			const authToken = authInput || current?.authToken;
			const userId = userInput || current?.userId;

			if (!url || !authToken || !userId) {
				return ctx.ui.notify("Need URL, token, user id.", "warning");
			}

			writeConfig({ url, authToken, userId });
			ctx.ui.notify(`Loki saved: ${CONFIG_FILE}`, "success");
		},
	});

	pi.registerCommand("loki-status", {
		description: "Show Loki logger status",
		handler: async (_args, ctx) => {
			const current = readConfig();

			if (!current) {
				ctx.ui.notify("Loki off. Run /loki-setup.", "info");
				return;
			}

			ctx.ui.notify(`Loki on. Local: ${LOCAL_DIR}`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		cleanKeepNewestSessions();

		logEvent(ctx, "system", "system", {
			event: "session_start",
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		logEvent(ctx, "system", "system", {
			event: "session_shutdown",
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});
	});

	pi.on("input", async (event, ctx) => {
		logEvent(ctx, "input", event.source, event);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});

	pi.on("agent_start", async (_event, ctx) => {
		logEvent(ctx, "system", "system", { event: "agent_start" });
	});

	pi.on("agent_end", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});

	pi.on("turn_start", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});

	pi.on("turn_end", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});

	pi.on("message_start", async (event, ctx) => {
		logEvent(
			ctx,
			messageEventTypeForRole(event.message.role),
			event.message.role,
			event.message,
		);
	});

	pi.on("message_update", async (event, ctx) => {
		logEvent(
			ctx,
			messageEventTypeForRole(event.message.role),
			event.message.role,
			{
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			},
		);
	});

	pi.on("message_end", async (event, ctx) => {
		logEvent(
			ctx,
			messageEventTypeForRole(event.message.role),
			event.message.role,
			event.message,
		);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		logEvent(ctx, "tool_call", "assistant", event);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		logEvent(ctx, "tool_result", "tool", event);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		logEvent(ctx, "tool_result", "tool", event);
	});

	pi.on("tool_call", async (event, ctx) => {
		logEvent(ctx, "tool_call", "assistant", event);
	});

	pi.on("tool_result", async (event, ctx) => {
		logEvent(ctx, "tool_result", "tool", event);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		logEvent(ctx, "system", "system", {
			event: "before_provider_request",
			payload: event.payload,
		});
	});

	pi.on("after_provider_response", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});

	pi.on("model_select", async (event, ctx) => {
		logEvent(ctx, "system", "system", {
			event: "model_select",
			model: event.model,
			previousModel: event.previousModel,
			source: event.source,
		});
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		logEvent(ctx, "system", "system", event);
	});
}
