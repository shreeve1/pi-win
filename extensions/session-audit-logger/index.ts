import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

const MAX_STRING_CHARS = 200_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_DEPTH = 12;
const MAX_EVENT_BYTES = 1_000_000;
const PREVIEW_CHARS = 2_000;
const SUMMARY_SAMPLE_ITEMS = 10;

const FULL_CONTENT = process.env.PI_AUDIT_FULL_CONTENT === "1";
const FULL_PROVIDER_PAYLOAD =
	process.env.PI_AUDIT_FULL_PROVIDER_PAYLOAD === "1";
const INCLUDE_HOST_USER = process.env.PI_AUDIT_INCLUDE_HOST_USER === "1";
const CONTENT_PREVIEW = process.env.PI_AUDIT_CONTENT_PREVIEW === "1";

const SECRET_KEY_RE =
	/^(?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|credential)$/i;
const SECRET_NAME_RE =
	/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|authorization|cookie|credential)/i;

let auditLogPath = "";
let auditSummaryPath = "";
let startedAt = new Date().toISOString();
let sessionId = "unknown-session";
let sessionFile: string | undefined;
let auditRoot = resolveAuditRoot();
let sequence = 0;
const eventCounts = new Map<string, number>();
let lastWriteError: string | undefined;

function resetAuditState(): void {
	auditLogPath = "";
	auditSummaryPath = "";
	sessionId = "unknown-session";
	sessionFile = undefined;
	sequence = 0;
	eventCounts.clear();
	lastWriteError = undefined;
}

function utcStampForPath(date = new Date()): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function resolveAuditRoot(ctx?: ExtensionContext): string {
	return (
		process.env.PI_CODING_AGENT_DIR ||
		(process.platform === "win32"
			? "C:\\ProgramData\\pi-win"
			: ctx?.cwd || process.cwd())
	);
}

function safeFileName(value: string): string {
	const cleaned = value
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 120) || "unknown-session";
}

function truncateString(value: string, max = MAX_STRING_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function redactString(value: string): string {
	let redacted = value;
	redacted = redacted.replace(
		/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
		"Bearer [REDACTED]",
	);
	redacted = redacted.replace(
		/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_-]{16,}\b/g,
		"$1_[REDACTED]",
	);
	redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]");
	redacted = redacted.replace(
		/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|authorization|cookie|credential)\s*[:=]\s*["']?)([^"'\s,;]+)/gi,
		"$1[REDACTED]",
	);
	redacted = redacted.replace(
		/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)([^&#\s]+)/gi,
		"$1[REDACTED]",
	);
	return redacted;
}

function isLargeBinaryLikeField(key: string, value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1_000) return false;
	return /^(?:data|base64|image|imageData|bytes|buffer)$/i.test(key);
}

function sanitizeString(value: string, key: string): string {
	if (isLargeBinaryLikeField(key, value)) {
		return `[omitted ${value.length} chars from ${key}]`;
	}
	return truncateString(redactString(value));
}

function sanitizePrimitive(value: unknown, key: string): unknown {
	if (typeof value === "string") return sanitizeString(value, key);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") {
		return `[function ${value.name || "anonymous"}]`;
	}
	if (typeof value !== "object") return String(value);
	return undefined;
}

function sanitizeArray(
	value: unknown[],
	seen: WeakSet<object>,
	depth: number,
): unknown[] {
	const items = value
		.slice(0, MAX_ARRAY_ITEMS)
		.map((item, index) => sanitizeValue(item, seen, depth + 1, String(index)));
	if (value.length > MAX_ARRAY_ITEMS) {
		items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
	}
	return items;
}

function sanitizeObject(
	value: Record<string, unknown>,
	seen: WeakSet<object>,
	depth: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		out[childKey] = sanitizeValue(childValue, seen, depth + 1, childKey);
	}
	return out;
}

function sanitizeValue(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
	key = "",
): unknown {
	if (SECRET_KEY_RE.test(key) || SECRET_NAME_RE.test(key)) {
		return "[REDACTED]";
	}

	if (value === null || value === undefined) return value;
	const primitive = sanitizePrimitive(value, key);
	if (primitive !== undefined) return primitive;

	if (seen.has(value)) return "[circular]";
	if (depth >= MAX_DEPTH) return "[max-depth]";
	seen.add(value);

	if (Array.isArray(value)) return sanitizeArray(value, seen, depth);
	return sanitizeObject(value as Record<string, unknown>, seen, depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function summarizeString(value: string): Record<string, unknown> {
	const redacted = redactString(value);
	const summary: Record<string, unknown> = {
		type: "string",
		chars: value.length,
		sha256: hashString(redacted),
	};
	if (CONTENT_PREVIEW) {
		summary.preview = truncateString(redacted, PREVIEW_CHARS);
	}
	return summary;
}

function summarizeValue(value: unknown, depth = 0): unknown {
	if (FULL_CONTENT) return sanitizeValue(value);
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return summarizeString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function")
		return `[function ${value.name || "anonymous"}]`;
	if (depth >= 3) return { type: typeof value, truncated: "max-summary-depth" };

	if (Array.isArray(value)) {
		return {
			type: "array",
			length: value.length,
			sample: value
				.slice(0, SUMMARY_SAMPLE_ITEMS)
				.map((item) => summarizeValue(item, depth + 1)),
			truncatedItems: Math.max(0, value.length - SUMMARY_SAMPLE_ITEMS),
		};
	}

	if (isRecord(value)) {
		const keys = Object.keys(value);
		const summary: Record<string, unknown> = {
			type: "object",
			keys: keys.slice(0, SUMMARY_SAMPLE_ITEMS),
			keyCount: keys.length,
		};
		for (const key of keys.slice(0, SUMMARY_SAMPLE_ITEMS)) {
			if (SECRET_KEY_RE.test(key) || SECRET_NAME_RE.test(key)) {
				summary[key] = "[REDACTED]";
			} else {
				summary[key] = summarizeValue(value[key], depth + 1);
			}
		}
		return summary;
	}

	return String(value);
}

function summarizeMessage(message: unknown): unknown {
	if (FULL_CONTENT) return sanitizeValue(message);
	if (!isRecord(message)) return summarizeValue(message);

	const out: Record<string, unknown> = {
		role: stringField(message, "role"),
		type: stringField(message, "type"),
		customType: stringField(message, "customType"),
	};
	if ("content" in message) out.content = summarizeValue(message.content);
	if ("text" in message) out.text = summarizeValue(message.text);
	if ("usage" in message) out.usage = sanitizeValue(message.usage);
	if ("toolCalls" in message && Array.isArray(message.toolCalls)) {
		out.toolCallCount = message.toolCalls.length;
		out.toolCalls = message.toolCalls
			.slice(0, SUMMARY_SAMPLE_ITEMS)
			.map((toolCall) => summarizeToolEvent(toolCall));
	}
	return out;
}

function summarizeToolEvent(event: unknown): unknown {
	if (FULL_CONTENT) return sanitizeValue(event);
	if (!isRecord(event)) return summarizeValue(event);

	const out: Record<string, unknown> = {};
	for (const key of [
		"toolName",
		"toolCallId",
		"id",
		"name",
		"isError",
		"exitCode",
	]) {
		if (key in event) out[key] = sanitizeValue(event[key], undefined, 0, key);
	}
	for (const key of [
		"args",
		"input",
		"result",
		"content",
		"details",
		"partialResult",
		"output",
	]) {
		if (key in event) out[key] = summarizeValue(event[key]);
	}
	return out;
}

function summarizeProviderPayload(payload: unknown): unknown {
	if (FULL_PROVIDER_PAYLOAD) return sanitizeValue(payload);
	if (!isRecord(payload)) return summarizeValue(payload);

	const out: Record<string, unknown> = {
		captureMode: "summary",
		keys: Object.keys(payload),
	};
	for (const key of [
		"model",
		"max_tokens",
		"maxTokens",
		"temperature",
		"stream",
	]) {
		if (key in payload)
			out[key] = sanitizeValue(payload[key], undefined, 0, key);
	}
	if (Array.isArray(payload.messages))
		out.messageCount = payload.messages.length;
	if (Array.isArray(payload.tools)) out.toolCount = payload.tools.length;
	if ("system" in payload) out.system = summarizeValue(payload.system);
	if ("input" in payload) out.input = summarizeValue(payload.input);
	return out;
}

function currentSessionDetails(): Record<string, unknown> {
	const host = process.env.COMPUTERNAME || process.env.HOSTNAME;
	const user =
		process.env.USERDOMAIN && process.env.USERNAME
			? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
			: process.env.USERNAME;
	return {
		sessionId,
		sessionFile: sessionFile ? basename(sessionFile) : undefined,
		auditRoot,
		pid: process.pid,
		...(INCLUDE_HOST_USER
			? { host, user }
			: {
					hostHash: host ? hashString(host) : undefined,
					userHash: user ? hashString(user) : undefined,
				}),
	};
}

function ensureAuditPaths(ctx?: ExtensionContext): void {
	if (auditLogPath) return;

	const root = resolveAuditRoot(ctx);
	const nextSessionFile = ctx?.sessionManager.getSessionFile();
	const rawSessionId =
		ctx?.sessionManager.getSessionId?.() ||
		(nextSessionFile
			? basename(nextSessionFile).replace(/\.jsonl$/i, "")
			: `${utcStampForPath()}-${process.pid}`);
	const nextSessionId = safeFileName(String(rawSessionId));
	const nextAuditDir = join(root, "artifacts", "sessions", nextSessionId);
	const nextAuditLogPath = join(nextAuditDir, "audit.jsonl");
	const nextAuditSummaryPath = join(nextAuditDir, "audit-summary.md");

	mkdirSync(nextAuditDir, { recursive: true });
	auditRoot = root;
	sessionFile = nextSessionFile;
	sessionId = nextSessionId;
	auditLogPath = nextAuditLogPath;
	auditSummaryPath = nextAuditSummaryPath;
}

function safeEnsureAuditPaths(ctx?: ExtensionContext): boolean {
	try {
		ensureAuditPaths(ctx);
		return true;
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
		return false;
	}
}

function formatEventLine(eventName: string, data: unknown): string {
	const record = {
		timestamp: new Date().toISOString(),
		sequence: ++sequence,
		event: eventName,
		...currentSessionDetails(),
		data: sanitizeValue(data),
	};

	const line = JSON.stringify(record);
	if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) return line;

	const compactRecord = {
		timestamp: record.timestamp,
		sequence: record.sequence,
		event: eventName,
		...currentSessionDetails(),
		data: {
			truncated: true,
			originalBytes: Buffer.byteLength(line, "utf8"),
			preview: truncateString(line, 20_000),
		},
	};
	return JSON.stringify(compactRecord);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeSummary(endedAt?: string): void {
	if (!auditSummaryPath) return;
	const counts = [...eventCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => `| ${name} | ${count} |`)
		.join("\n");

	const content = [
		"# Pi-Win AI Session Audit",
		"",
		`- Session ID: ${sessionId}`,
		`- Started: ${startedAt}`,
		`- Ended: ${endedAt ?? "in progress"}`,
		`- Audit root: ${auditRoot}`,
		`- Pi session file: ${sessionFile ? basename(sessionFile) : "unknown"}`,
		`- JSONL audit log: ${auditLogPath}`,
		`- Full content capture: ${FULL_CONTENT ? "enabled" : "disabled"}`,
		`- Full provider payload capture: ${FULL_PROVIDER_PAYLOAD ? "enabled" : "disabled"}`,
		`- Raw host/user capture: ${INCLUDE_HOST_USER ? "enabled" : "disabled"}`,
		lastWriteError
			? `- Last write error: ${lastWriteError}`
			: "- Last write error: none",
		"",
		"## Event counts",
		"",
		"| Event | Count |",
		"| --- | ---: |",
		counts || "| none | 0 |",
		"",
	].join("\n");

	try {
		writeFileSync(auditSummaryPath, content, "utf8");
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
	}
}

function logEvent(
	eventName: string,
	data: unknown = {},
	ctx?: ExtensionContext,
): void {
	try {
		ensureAuditPaths(ctx);
		eventCounts.set(eventName, (eventCounts.get(eventName) ?? 0) + 1);
		appendFileSync(
			auditLogPath,
			`${formatEventLine(eventName, data)}\n`,
			"utf8",
		);
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		const needsNewAuditState = event.reason !== "reload" || !auditLogPath;
		if (needsNewAuditState) {
			resetAuditState();
			startedAt = new Date().toISOString();
		}
		logEvent(
			"session_start",
			{
				reason: event.reason,
				previousSessionFile: summarizeValue(event.previousSessionFile),
				model: ctx.model
					? {
							provider: ctx.model.provider,
							id: ctx.model.id,
							name: ctx.model.name,
						}
					: undefined,
				thinkingLevel: pi.getThinkingLevel(),
				activeTools: pi.getActiveTools(),
			},
			ctx,
		);
		writeSummary();
	});

	pi.on("session_before_switch", (event, ctx) => {
		logEvent("session_before_switch", summarizeValue(event), ctx);
	});

	pi.on("session_before_fork", (event, ctx) => {
		logEvent("session_before_fork", summarizeValue(event), ctx);
	});

	pi.on("session_before_compact", (event, ctx) => {
		logEvent(
			"session_before_compact",
			{
				customInstructions: summarizeValue(event.customInstructions),
				branchEntryCount: event.branchEntries.length,
				preparation: summarizeValue(event.preparation),
			},
			ctx,
		);
	});

	pi.on("session_compact", (event, ctx) => {
		logEvent(
			"session_compact",
			{
				fromExtension: event.fromExtension,
				compactionEntry: summarizeMessage(event.compactionEntry),
			},
			ctx,
		);
	});

	pi.on("session_before_tree", (event, ctx) => {
		logEvent(
			"session_before_tree",
			{
				preparation: summarizeValue(event.preparation),
			},
			ctx,
		);
	});

	pi.on("session_tree", (event, ctx) => {
		logEvent("session_tree", summarizeValue(event), ctx);
	});

	pi.on("input", (event, ctx) => {
		logEvent(
			"input",
			{
				source: event.source,
				text: summarizeValue(event.text),
				imageCount: event.images?.length ?? 0,
			},
			ctx,
		);
	});

	pi.on("before_agent_start", (event, ctx) => {
		logEvent(
			"before_agent_start",
			{
				prompt: summarizeValue(event.prompt),
				imageCount: event.images?.length ?? 0,
				systemPrompt: summarizeValue(event.systemPrompt),
				systemPromptOptions: summarizeValue(event.systemPromptOptions),
			},
			ctx,
		);
	});

	pi.on("agent_start", (event, ctx) => {
		logEvent("agent_start", summarizeValue(event), ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		logEvent(
			"agent_end",
			{
				messageCount: event.messages.length,
				messages: event.messages.map((message) => summarizeMessage(message)),
			},
			ctx,
		);
		writeSummary();
	});

	pi.on("turn_start", (event, ctx) => {
		logEvent("turn_start", summarizeValue(event), ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		logEvent(
			"turn_end",
			{
				turnIndex: event.turnIndex,
				message: summarizeMessage(event.message),
				toolResults: summarizeValue(event.toolResults),
			},
			ctx,
		);
	});

	pi.on("message_start", (event, ctx) => {
		logEvent(
			"message_start",
			{
				role: event.message.role,
				message: summarizeMessage(event.message),
			},
			ctx,
		);
	});

	pi.on("message_end", (event, ctx) => {
		logEvent(
			"message_end",
			{
				role: event.message.role,
				message: summarizeMessage(event.message),
			},
			ctx,
		);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		logEvent("tool_execution_start", summarizeToolEvent(event), ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		logEvent("tool_execution_update", summarizeToolEvent(event), ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		logEvent("tool_call", summarizeToolEvent(event), ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		logEvent("tool_result", summarizeToolEvent(event), ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		logEvent("tool_execution_end", summarizeToolEvent(event), ctx);
	});

	pi.on("user_bash", (event, ctx) => {
		logEvent("user_bash", summarizeToolEvent(event), ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		logEvent(
			"before_provider_request",
			{
				payload: summarizeProviderPayload(event.payload),
			},
			ctx,
		);
	});

	pi.on("after_provider_response", (event, ctx) => {
		logEvent("after_provider_response", summarizeValue(event), ctx);
	});

	pi.on("model_select", (event, ctx) => {
		logEvent(
			"model_select",
			{
				source: event.source,
				previousModel: event.previousModel
					? {
							provider: event.previousModel.provider,
							id: event.previousModel.id,
							name: event.previousModel.name,
						}
					: undefined,
				model: {
					provider: event.model.provider,
					id: event.model.id,
					name: event.model.name,
				},
			},
			ctx,
		);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		logEvent("thinking_level_select", summarizeValue(event), ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		const endedAt = new Date().toISOString();
		logEvent("session_shutdown", summarizeValue(event), ctx);
		writeSummary(endedAt);
	});

	pi.registerCommand("audit-log", {
		description: "Show current pi-win AI audit log path",
		handler: (_args, ctx) => {
			if (safeEnsureAuditPaths(ctx)) {
				logEvent("audit_log_command", { auditLogPath, auditSummaryPath }, ctx);
			}
			return Promise.resolve();
		},
	});
}
