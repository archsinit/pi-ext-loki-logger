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
const THINKING_LIMIT = 120;
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
	preview: string;
	raw: string;
	message_text?: string;
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

function sanitizeForLog(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return undefined;
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeForLog(item))
			.filter((item) => item !== undefined);
	}
	if (typeof value !== "object") return String(value);

	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [key, current] of Object.entries(record)) {
		const lowerKey = key.toLowerCase();
		if (lowerKey.includes("encrypted") || key === "thinkingSignature") continue;

		if (key === "thinking" && typeof current === "string") {
			out[key] = current.length > THINKING_LIMIT ? `${current.slice(0, THINKING_LIMIT)}…` : current;
			continue;
		}

		const next = sanitizeForLog(current);
		if (next !== undefined) out[key] = next;
	}

	if (out.type === "thinking" && typeof out.thinking === "string") {
		out.thinking = out.thinking.length > THINKING_LIMIT ? `${out.thinking.slice(0, THINKING_LIMIT)}…` : out.thinking;
	}

	return out;
}

function safeJson(value: unknown): string {
	if (typeof value === "string") return value;

	try {
		return JSON.stringify(sanitizeForLog(value), (_key, current) => {
			if (typeof current === "bigint") return current.toString();
			return current;
		});
	} catch {
		return String(value);
	}
}

function summarize(raw: string): string {
	return raw.replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
}

function previewText(raw: string): string {
	return raw.replace(/\s+/g, " ").slice(0, LOKI_RAW_LIMIT);
}

function extractMessageText(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;

	if (Array.isArray(value)) {
		const parts = value
			.map((item) => extractMessageText(item))
			.filter((part): part is string => Boolean(part));

		return parts.length ? parts.join(" ").trim() || undefined : undefined;
	}

	if (!value || typeof value !== "object") return undefined;

	const record = value as Record<string, unknown>;

	if (record.type === "text" && typeof record.text === "string") {
		return record.text.trim() || undefined;
	}

	if (typeof record.text === "string" && record.text.trim()) {
		return record.text.trim();
	}

	if (typeof record.content === "string" && record.content.trim()) {
		return record.content.trim();
	}

	for (const key of ["content", "message", "messages", "payload", "delta", "output", "result"] as const) {
		const extracted = extractMessageText(record[key]);
		if (extracted) return extracted;
	}

	return undefined;
}

function nowIso() {
	return new Date().toISOString();
}

function nowNs(): string {
	return `${BigInt(Date.now()) * 1_000_000n}`;
}

function getModelId(ctx: { model?: { id?: string } } & { getModel?: () => { id?: string } | undefined }): string {
	return ctx.model?.id ?? ctx.getModel?.()?.id ?? "unknown";
}

function messageEventTypeForRole(role: string | undefined): string {
	const value = String(role ?? "system");
	if (value === "assistant") return "output";
	if (value === "user") return "input";
	if (value.toLowerCase().includes("tool")) return "tool_result";
	return "system";
}

function normalizeLokiUrl(url: string): string {
	return url.endsWith("/loki/api/v1/push") ? url : `${url.replace(/\/$/, "")}/loki/api/v1/push`;
}

function toLokiEntry(entry: LogShape): Omit<LogShape, "raw" | "message_text" | "summary"> {
	return {
		ts: entry.ts,
		session_id: entry.session_id,
		channel: entry.channel,
		model: entry.model,
		event_type: entry.event_type,
		role: entry.role,
		preview: entry.preview,
		chars: entry.chars,
		truncated: entry.truncated,
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

	const res = await fetch(normalizeLokiUrl(config.url), {
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
		model?: { id?: string };
		getModel?: () => { id?: string } | undefined;
		sessionManager: { getSessionId: () => string };
	},
	eventType: string,
	role: string,
	payload: unknown,
) {
	const config = readConfig();
	const sessionId = ctx.sessionManager.getSessionId();
	const raw = safeJson(payload);
	const messageText = extractMessageText(payload);
	const displayText = messageText ?? raw;

	const entry: LogShape = {
		ts: nowIso(),
		session_id: sessionId,
		channel: CHANNEL,
		model: getModelId(ctx),
		event_type: eventType,
		role,
		preview: previewText(displayText),
		raw,
		message_text: messageText,
		summary: summarize(displayText),
		chars: displayText.length,
		truncated: displayText.length > SUMMARY_LIMIT,
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

		logEvent(ctx, "session_start", "system", {
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		logEvent(ctx, "session_shutdown", "system", {
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		logEvent(ctx, "before_agent_start", "system", event);
	});

	pi.on("agent_start", async (_event, ctx) => {
		logEvent(ctx, "agent_start", "system", { event: "agent_start" });
	});

	pi.on("agent_end", async (event, ctx) => {
		logEvent(ctx, "agent_end", "system", event);
	});

	pi.on("turn_start", async (event, ctx) => {
		logEvent(ctx, "turn_start", "system", event);
	});

	pi.on("turn_end", async (event, ctx) => {
		logEvent(ctx, "turn_end", "system", event);
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
		logEvent(ctx, "before_provider_request", "system", {
			payload: event.payload,
		});
	});

	pi.on("after_provider_response", async (event, ctx) => {
		logEvent(ctx, "after_provider_response", "system", event);
	});

	pi.on("model_select", async (event, ctx) => {
		logEvent(ctx, "model_select", "system", {
			model: event.model,
			previousModel: event.previousModel,
			source: event.source,
		});
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		logEvent(ctx, "thinking_level_select", "system", event);
	});
}
