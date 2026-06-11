import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";

const MAX_STRING_CHARS = 200_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_DEPTH = 12;
const MAX_EVENT_BYTES = 1_000_000;
const PREVIEW_CHARS = 2_000;
const SUMMARY_SAMPLE_ITEMS = 10;
const MAX_HASH_BYTES = 20 * 1024 * 1024;

const FULL_CONTENT = process.env.PI_AUDIT_FULL_CONTENT === "1";
const FULL_PROVIDER_PAYLOAD =
	process.env.PI_AUDIT_FULL_PROVIDER_PAYLOAD === "1";
const INCLUDE_HOST_USER = process.env.PI_AUDIT_INCLUDE_HOST_USER === "1";
const CONTENT_PREVIEW = process.env.PI_AUDIT_CONTENT_PREVIEW === "1";
const RAW_EVENTS = process.env.PI_AUDIT_RAW_EVENTS === "1";
const FILE_HASHES = process.env.PI_AUDIT_FILE_HASHES === "1";

const SECRET_KEY_RE =
	/^(?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|credential)$/i;
const SECRET_NAME_RE =
	/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|cookie|credential)/i;

let auditEventsPath = "";
let auditActionsPath = "";
let auditActionsMarkdownPath = "";
let auditSummaryPath = "";
let startedAt = new Date().toISOString();
let sessionId = "unknown-session";
let piSessionId: string | undefined;
let sessionFile: string | undefined;
let auditRoot = resolveAuditRoot();
let sequence = 0;
const eventCounts = new Map<string, number>();
const actionCounts = new Map<string, number>();
const recentActions: Array<Record<string, unknown>> = [];
const pendingActions = new Map<string, Record<string, unknown>>();
const pendingActionPaths = new Map<string, string>();
const latestToolStatus = new Map<string, Record<string, unknown>>();
let lastWriteError: string | undefined;

function resetAuditState(): void {
	auditEventsPath = "";
	auditActionsPath = "";
	auditActionsMarkdownPath = "";
	auditSummaryPath = "";
	sessionId = "unknown-session";
	piSessionId = undefined;
	sessionFile = undefined;
	sequence = 0;
	eventCounts.clear();
	actionCounts.clear();
	recentActions.length = 0;
	pendingActions.clear();
	pendingActionPaths.clear();
	latestToolStatus.clear();
	lastWriteError = undefined;
}

function utcStampForPath(date = new Date()): string {
	return date
		.toISOString()
		.replace(
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/,
			"$1$2$3-$4$5$6-$7Z",
		);
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
		/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|cookie|credential)\s*[:=]\s*["']?)([^"'\s,;]+)/gi,
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

function actionString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value);
}

function markdownCell(value: unknown): string {
	return actionString(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function redactedCommand(command: string): string {
	return truncateString(redactString(command), 4_000);
}

function toolInput(event: Record<string, unknown>): Record<string, unknown> {
	return isRecord(event.input) ? event.input : {};
}

function inputPath(input: Record<string, unknown>): string | undefined {
	const value = input.path ?? input.filePath ?? input.url;
	return typeof value === "string" ? redactString(value) : undefined;
}

function inputRawPath(input: Record<string, unknown>): string | undefined {
	const value = input.path ?? input.filePath;
	return typeof value === "string" ? value : undefined;
}

function fileProof(
	pathValue: string | undefined,
	ctx?: ExtensionContext,
): Record<string, unknown> | undefined {
	if (!FILE_HASHES || !pathValue) return undefined;
	try {
		const absolutePath = isAbsolute(pathValue)
			? pathValue
			: resolve(ctx?.cwd ?? process.cwd(), pathValue);
		if (!existsSync(absolutePath)) return { exists: false };
		const stat = statSync(absolutePath);
		const proof: Record<string, unknown> = {
			exists: true,
			bytes: stat.size,
		};
		if (!stat.isFile()) {
			proof.hashSkippedReason = "not-regular-file";
			return proof;
		}
		if (stat.size > MAX_HASH_BYTES) {
			proof.hashSkippedReason = `larger-than-${MAX_HASH_BYTES}-bytes`;
			return proof;
		}
		proof.sha256 = createHash("sha256")
			.update(readFileSync(absolutePath))
			.digest("hex");
		return proof;
	} catch (error: unknown) {
		return { exists: undefined, hashSkippedReason: errorMessage(error) };
	}
}

function prefixedFileProof(
	pathValue: string | undefined,
	prefix: "before" | "after" | "atCall",
	ctx?: ExtensionContext,
): Record<string, unknown> {
	const proof = fileProof(pathValue, ctx);
	if (!proof) return {};
	const fields: Record<string, unknown> = {};
	if (prefix === "before") {
		fields.existsBefore = proof.exists;
		fields.beforeBytes = proof.bytes;
		fields.beforeHash = proof.sha256;
		fields.beforeHashSkippedReason = proof.hashSkippedReason;
	} else if (prefix === "after") {
		fields.existsAfter = proof.exists;
		fields.afterBytes = proof.bytes;
		fields.afterHash = proof.sha256;
		fields.afterHashSkippedReason = proof.hashSkippedReason;
	} else {
		fields.existsAtCall = proof.exists;
		fields.bytesAtCall = proof.bytes;
		fields.hashAtCall = proof.sha256;
		fields.hashAtCallSkippedReason = proof.hashSkippedReason;
	}
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
}

function byteDeltaFields(
	action: Record<string, unknown>,
	completion: Record<string, unknown>,
): Record<string, unknown> {
	const beforeBytes = action.beforeBytes;
	const afterBytes = completion.afterBytes;
	if (typeof beforeBytes !== "number" || typeof afterBytes !== "number") {
		return {};
	}
	return { byteDelta: afterBytes - beforeBytes };
}

function extractCommandPaths(command: string): string[] {
	const paths = new Set<string>();
	const quoted = command.match(/["']([A-Za-z]:\\[^"']+)["']/g) ?? [];
	for (const match of quoted) paths.add(match.slice(1, -1));
	const bare = command.match(/\b[A-Za-z]:\\[^\s;|'"]+/g) ?? [];
	for (const match of bare) paths.add(match);
	return [...paths].slice(0, 20).map(redactString);
}

function opaqueShellReasons(command: string): string[] {
	const reasons: string[] = [];
	if (/-(?:encodedcommand|enc)\b/i.test(command))
		reasons.push("encoded-command");
	if (/\b(?:invoke-expression|iex)\b/i.test(command))
		reasons.push("invoke-expression");
	if (
		/\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b[\s\S]*\|\s*(?:invoke-expression|iex)\b/i.test(
			command,
		)
	) {
		reasons.push("download-piped-to-expression");
	}
	if (/\.ps1(?:\b|[\s'"`])/i.test(command)) reasons.push("ps1-execution");
	if (/\bstart-process\b/i.test(command)) reasons.push("start-process");
	if (/\bcmd(?:\.exe)?\s*\/c\b/i.test(command)) reasons.push("cmd-c");
	if (
		/\bpowershell(?:\.exe)?\s+(?:-[^\s]+\s+)*-(?:command|c)\b/i.test(command)
	) {
		reasons.push("nested-powershell-command");
	}
	if (
		/(?:^|[\s&;|])(?:&\s*)?(?:["']?(?:[A-Za-z]:\\|\.\\|\.\/|\/)[^\s'"`|&;]+\.exe["']?)/i.test(
			command,
		)
	) {
		reasons.push("external-executable-path");
	}
	return [...new Set(reasons)];
}

function classifyShellCommand(command: string): Record<string, unknown> {
	const lower = command.toLowerCase();
	const riskReasons = opaqueShellReasons(command);
	const opaqueShell = riskReasons.length > 0;
	const deleteRisk =
		/\bremove-item\b/i.test(command) ||
		/\b(del|erase|rmdir|rd)\b/i.test(command) ||
		/(^|[\s;&|])rm\s+/i.test(command);
	const writeRisk =
		!opaqueShell &&
		(/\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i.test(
			command,
		) ||
			/(^|[\s;&|])(copy|move|ren)\s+/i.test(command));
	const readLike =
		!opaqueShell &&
		(/\b(get-content|get-childitem|select-string)\b/i.test(command) ||
			/(^|[\s;&|])(type|dir)\s+/i.test(command));
	const recursive =
		/\b-recurse\b/i.test(command) || /\s-[a-z]*r[a-z]*\b/i.test(lower);
	const force =
		/\b-force\b/i.test(command) || /\s-[a-z]*f[a-z]*\b/i.test(lower);
	return {
		classification: deleteRisk
			? "delete_risk"
			: opaqueShell
				? "opaque_shell_execution"
				: writeRisk
					? "filesystem_change"
					: readLike
						? "filesystem_read"
						: "shell_command",
		deleteRisk,
		writeRisk,
		readLike,
		opaqueShell,
		riskReasons,
		recursive,
		force,
		paths: extractCommandPaths(command),
	};
}

function urlParts(url: string): Record<string, unknown> {
	try {
		const parsed = new URL(url);
		return {
			host: parsed.host,
			path: parsed.pathname,
			protocol: parsed.protocol,
		};
	} catch {
		return { url: redactString(url) };
	}
}

function actionFromToolCall(
	event: unknown,
	ctx?: ExtensionContext,
): Record<string, unknown> {
	if (!isRecord(event))
		return { action: "tool_call", details: summarizeValue(event) };
	const toolName =
		stringField(event, "toolName") ?? stringField(event, "name") ?? "unknown";
	const toolCallId =
		stringField(event, "toolCallId") ?? stringField(event, "id");
	const input = toolInput(event);
	const rawPath = inputRawPath(input);
	const base: Record<string, unknown> = {
		toolName,
		toolCallId,
		status: "started",
		startedAt: new Date().toISOString(),
	};

	if (toolName === "read") {
		return {
			...base,
			action: "file_read",
			path: inputPath(input),
			offset: input.offset,
			limit: input.limit,
			...prefixedFileProof(rawPath, "atCall", ctx),
		};
	}
	if (toolName === "write") {
		return {
			...base,
			action: "file_write",
			path: inputPath(input),
			content: summarizeValue(input.content),
			...prefixedFileProof(rawPath, "before", ctx),
		};
	}
	if (toolName === "edit") {
		return {
			...base,
			action: "file_edit",
			path: inputPath(input),
			edits: summarizeValue(input.edits),
			...prefixedFileProof(rawPath, "before", ctx),
		};
	}
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const classification = classifyShellCommand(command);
		return {
			...base,
			action: classification.deleteRisk
				? "delete_risk"
				: classification.opaqueShell
					? "opaque_shell_execution"
					: "shell_command",
			command: redactedCommand(command),
			...classification,
		};
	}
	if (toolName === "web_fetch") {
		const url = typeof input.url === "string" ? input.url : "";
		return {
			...base,
			action: "network_access",
			...urlParts(url),
			format: input.format,
		};
	}
	if (toolName === "web_search") {
		return {
			...base,
			action: "web_search",
			query: summarizeValue(input.query),
			numResults: input.numResults ?? input.max_results,
		};
	}
	return { ...base, action: "tool_call", input: summarizeValue(input) };
}

function actionFromToolResult(event: unknown): Record<string, unknown> {
	if (!isRecord(event))
		return { action: "tool_result", details: summarizeValue(event) };
	return {
		action: "tool_result",
		toolName: stringField(event, "toolName") ?? stringField(event, "name"),
		toolCallId: stringField(event, "toolCallId") ?? stringField(event, "id"),
		status: event.isError ? "error" : "completed",
		isError: event.isError,
		content: summarizeValue(event.content),
		details: summarizeValue(event.details),
	};
}

function toolCallIdFromEvent(
	event: Record<string, unknown>,
): string | undefined {
	return stringField(event, "toolCallId") ?? stringField(event, "id");
}

function toolEventInput(
	event: Record<string, unknown>,
): Record<string, unknown> {
	if (isRecord(event.input)) return event.input;
	if (isRecord(event.args)) return event.args;
	return {};
}

function actionTarget(action: Record<string, unknown>): unknown {
	if (typeof action.host === "string" && typeof action.path === "string") {
		const protocol = typeof action.protocol === "string" ? action.protocol : "";
		return `${protocol}//${action.host}${action.path}`;
	}
	return (
		action.path ??
		action.host ??
		action.command ??
		action.query ??
		action.toolName ??
		""
	);
}

function completePendingToolAction(
	event: unknown,
	lifecycleEvent: "tool_result" | "tool_execution_end",
	ctx?: ExtensionContext,
): Record<string, unknown> {
	if (!isRecord(event)) return actionFromToolResult(event);
	const toolCallId = toolCallIdFromEvent(event);
	const pending = toolCallId ? pendingActions.get(toolCallId) : undefined;
	if (!toolCallId || !pending) return actionFromToolResult(event);

	const completedAt = new Date().toISOString();
	const startedAt =
		typeof pending.startedAt === "string" ? pending.startedAt : "";
	const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
	const completedMs = Date.parse(completedAt);
	const durationMs = Number.isFinite(startedMs)
		? Math.max(0, completedMs - startedMs)
		: undefined;
	const isError = event.isError === true;
	const status = isError ? "error" : "completed";

	pending.status = status;
	pending.completedAt = completedAt;
	pending.durationMs = durationMs;
	pending.isError = isError;

	const completion: Record<string, unknown> = {
		completedAction: pending.action,
		target: actionTarget(pending),
		toolName:
			pending.toolName ??
			stringField(event, "toolName") ??
			stringField(event, "name"),
		toolCallId,
		path: pending.path,
		host: pending.host,
		command: pending.command,
		status,
		isError,
		startedAt,
		completedAt,
		durationMs,
		lifecycleEvent,
	};

	if (lifecycleEvent === "tool_result") {
		completion.content = summarizeValue(event.content);
		completion.details = summarizeValue(event.details);
	} else {
		completion.result = summarizeValue(event.result);
	}

	if (pending.action === "file_write" || pending.action === "file_edit") {
		const rawPath =
			inputRawPath(toolEventInput(event)) ?? pendingActionPaths.get(toolCallId);
		Object.assign(completion, prefixedFileProof(rawPath, "after", ctx));
		Object.assign(completion, byteDeltaFields(pending, completion));
	}

	latestToolStatus.set(toolCallId, completion);
	pendingActions.delete(toolCallId);
	pendingActionPaths.delete(toolCallId);
	return completion;
}

function currentSessionDetails(): Record<string, unknown> {
	const host = process.env.COMPUTERNAME || process.env.HOSTNAME;
	const user =
		process.env.USERDOMAIN && process.env.USERNAME
			? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
			: process.env.USERNAME;
	return {
		sessionId,
		piSessionId,
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
	if (auditActionsPath) return;

	const root = resolveAuditRoot(ctx);
	const nextSessionFile = ctx?.sessionManager.getSessionFile();
	const rawPiSessionId =
		ctx?.sessionManager.getSessionId?.() ||
		(nextSessionFile
			? basename(nextSessionFile).replace(/\.jsonl$/i, "")
			: undefined);
	const nextSessionId = safeFileName(utcStampForPath(new Date(startedAt)));
	const nextAuditDir = join(root, "artifacts", "sessions", nextSessionId);
	const nextAuditEventsPath = join(nextAuditDir, "audit-events.jsonl");
	const nextAuditActionsPath = join(nextAuditDir, "audit-actions.jsonl");
	const nextAuditActionsMarkdownPath = join(nextAuditDir, "audit-actions.md");
	const nextAuditSummaryPath = join(nextAuditDir, "audit-summary.md");

	mkdirSync(nextAuditDir, { recursive: true });
	auditRoot = root;
	piSessionId = rawPiSessionId ? String(rawPiSessionId) : undefined;
	sessionFile = nextSessionFile;
	sessionId = nextSessionId;
	auditEventsPath = nextAuditEventsPath;
	auditActionsPath = nextAuditActionsPath;
	auditActionsMarkdownPath = nextAuditActionsMarkdownPath;
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
		`- Audit session ID: ${sessionId}`,
		`- Pi session ID: ${piSessionId ?? "unknown"}`,
		`- Started: ${startedAt}`,
		`- Ended: ${endedAt ?? "in progress"}`,
		`- Audit root: ${auditRoot}`,
		`- Pi session file: ${sessionFile ? basename(sessionFile) : "unknown"}`,
		`- Action ledger: ${auditActionsPath}`,
		`- Action report: ${auditActionsMarkdownPath}`,
		`- Raw event log: ${RAW_EVENTS ? auditEventsPath : "disabled"}`,
		`- File hash proof mode: ${FILE_HASHES ? "enabled" : "disabled"}`,
		`- Full content capture: ${FULL_CONTENT ? "enabled" : "disabled"}`,
		`- Full provider payload capture: ${FULL_PROVIDER_PAYLOAD ? "enabled" : "disabled"}`,
		`- Raw host/user capture: ${INCLUDE_HOST_USER ? "enabled" : "disabled"}`,
		lastWriteError
			? `- Last write error: ${lastWriteError}`
			: "- Last write error: none",
		"",
		"## Action counts",
		"",
		"| Action | Count |",
		"| --- | ---: |",
		[...actionCounts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, count]) => `| ${name} | ${count} |`)
			.join("\n") || "| none | 0 |",
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

function formatActionLine(
	actionName: string,
	data: Record<string, unknown>,
): string {
	const record = {
		timestamp: new Date().toISOString(),
		sequence: ++sequence,
		action: actionName,
		...currentSessionDetails(),
		...(sanitizeValue(data) as Record<string, unknown>),
	};
	return JSON.stringify(record);
}

function addFileRollup(
	rollup: Map<
		string,
		{
			reads: number;
			writes: number;
			edits: number;
			deleteRisk: number;
			status: string;
		}
	>,
	path: string,
	action: unknown,
	status: unknown,
): void {
	const row = rollup.get(path) ?? {
		reads: 0,
		writes: 0,
		edits: 0,
		deleteRisk: 0,
		status: "",
	};
	if (action === "file_read") row.reads += 1;
	if (action === "file_write") row.writes += 1;
	if (action === "file_edit") row.edits += 1;
	if (action === "delete_risk") row.deleteRisk += 1;
	if (typeof status === "string") row.status = status;
	rollup.set(path, row);
}

function fileRollupRows(): string {
	const rollup = new Map<
		string,
		{
			reads: number;
			writes: number;
			edits: number;
			deleteRisk: number;
			status: string;
		}
	>();
	for (const action of recentActions) {
		if (action.action === "tool_result") continue;
		if (
			typeof action.path === "string" &&
			["file_read", "file_write", "file_edit"].includes(String(action.action))
		) {
			addFileRollup(rollup, action.path, action.action, action.status);
		}
		if (action.action === "delete_risk" && Array.isArray(action.paths)) {
			for (const path of action.paths) {
				if (typeof path === "string")
					addFileRollup(rollup, path, action.action, action.status);
			}
		}
	}
	return [...rollup.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([path, row]) =>
				`| ${markdownCell(path)} | ${row.reads} | ${row.writes} | ${row.edits} | ${row.deleteRisk} | ${markdownCell(row.status)} |`,
		)
		.join("\n");
}

function toolLifecycleRows(): string {
	const rows = [...latestToolStatus.values()];
	for (const [toolCallId, action] of pendingActions.entries()) {
		if (latestToolStatus.has(toolCallId)) continue;
		rows.push({
			toolCallId,
			completedAction: action.action,
			target: actionTarget(action),
			startedAt: action.startedAt,
			completedAt: "",
			durationMs: "",
			status: action.status ?? "started",
		});
	}
	return rows
		.map(
			(action) =>
				`| ${markdownCell(action.toolCallId)} | ${markdownCell(action.completedAction ?? action.action)} | ${markdownCell(action.target)} | ${markdownCell(action.startedAt)} | ${markdownCell(action.completedAt)} | ${markdownCell(action.durationMs)} | ${markdownCell(action.status)} |`,
		)
		.join("\n");
}

function writeActionsMarkdown(endedAt?: string): void {
	if (!auditActionsMarkdownPath) return;
	const actionRows = recentActions
		.map(
			(action) =>
				`| ${markdownCell(action.timestamp)} | ${markdownCell(action.action)} | ${markdownCell(actionTarget(action))} | ${markdownCell(action.status ?? "")} | ${markdownCell(action.classification ?? action.note ?? action.riskReasons ?? "")} |`,
		)
		.join("\n");
	const deleteRows = recentActions
		.filter((action) => action.action === "delete_risk")
		.map(
			(action) =>
				`| ${markdownCell(action.timestamp)} | ${markdownCell(action.toolName)} | ${markdownCell(action.paths ?? action.path ?? "")} | ${markdownCell(action.recursive)} | ${markdownCell(action.force)} | ${markdownCell(action.opaqueShell)} |`,
		)
		.join("\n");
	const fileRows = recentActions
		.filter(
			(action) =>
				typeof action.path === "string" &&
				["file_read", "file_write", "file_edit"].includes(
					String(action.action),
				),
		)
		.map(
			(action) =>
				`| ${markdownCell(action.path)} | ${markdownCell(action.action)} | ${markdownCell(action.status ?? "")} |`,
		)
		.join("\n");
	const rollupRows = fileRollupRows();
	const lifecycleRows = toolLifecycleRows();

	const content = [
		"# Pi-Win AI Session Actions",
		"",
		`- Audit session ID: ${sessionId}`,
		`- Pi session ID: ${piSessionId ?? "unknown"}`,
		`- Started: ${startedAt}`,
		`- Ended: ${endedAt ?? "in progress"}`,
		`- JSONL action ledger: ${auditActionsPath}`,
		"",
		"## Action counts",
		"",
		"| Action | Count |",
		"| --- | ---: |",
		[...actionCounts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, count]) => `| ${name} | ${count} |`)
			.join("\n") || "| none | 0 |",
		"",
		"## Delete-risk commands",
		"",
		"| Timestamp | Tool | Paths | Recursive | Force | Opaque |",
		"| --- | --- | --- | --- | --- | --- |",
		deleteRows || "| none |  |  |  |  |  |",
		"",
		"## File activity rollup",
		"",
		"| Path | Reads | Writes | Edits | Delete-risk | Last status |",
		"| --- | ---: | ---: | ---: | ---: | --- |",
		rollupRows || "| none | 0 | 0 | 0 | 0 |  |",
		"",
		"## File activity",
		"",
		"| Path | Action | Status |",
		"| --- | --- | --- |",
		fileRows || "| none |  |  |",
		"",
		"## Tool lifecycle",
		"",
		"| ToolCallId | Action | Target | Started | Completed | Duration ms | Status |",
		"| --- | --- | --- | --- | --- | ---: | --- |",
		lifecycleRows || "| none |  |  |  |  |  |  |",
		"",
		"## Chronological actions",
		"",
		"| Timestamp | Action | Target | Status | Notes |",
		"| --- | --- | --- | --- | --- |",
		actionRows || "| none |  |  |  |  |",
		"",
	].join("\n");

	try {
		writeFileSync(auditActionsMarkdownPath, content, "utf8");
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
	}
}

function logAction(
	actionName: string,
	data: Record<string, unknown> = {},
	ctx?: ExtensionContext,
): Record<string, unknown> | undefined {
	try {
		ensureAuditPaths(ctx);
		actionCounts.set(actionName, (actionCounts.get(actionName) ?? 0) + 1);
		const record = {
			timestamp: new Date().toISOString(),
			action: actionName,
			...data,
		};
		recentActions.push(record);
		if (recentActions.length > 1_000) recentActions.shift();
		appendFileSync(
			auditActionsPath,
			`${formatActionLine(actionName, data)}\n`,
			"utf8",
		);
		return record;
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
		return undefined;
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
		if (RAW_EVENTS) {
			appendFileSync(
				auditEventsPath,
				`${formatEventLine(eventName, data)}\n`,
				"utf8",
			);
		}
	} catch (error: unknown) {
		lastWriteError = errorMessage(error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		const needsNewAuditState = event.reason !== "reload" || !auditActionsPath;
		if (needsNewAuditState) {
			resetAuditState();
			startedAt = new Date().toISOString();
		}
		const sessionData = {
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
		};
		logEvent("session_start", sessionData, ctx);
		logAction("session_start", sessionData, ctx);
		writeSummary();
		writeActionsMarkdown();
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
		const inputData = {
			source: event.source,
			text: summarizeValue(event.text),
			imageCount: event.images?.length ?? 0,
		};
		logEvent("input", inputData, ctx);
		logAction("user_prompt", inputData, ctx);
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
		writeActionsMarkdown();
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
		const action = actionFromToolCall(event, ctx);
		logEvent("tool_call", summarizeToolEvent(event), ctx);
		const loggedAction = logAction(
			String(action.action ?? "tool_call"),
			action,
			ctx,
		);
		if (isRecord(event)) {
			const toolCallId = toolCallIdFromEvent(event);
			if (toolCallId && loggedAction) {
				pendingActions.set(toolCallId, loggedAction);
				const rawPath = inputRawPath(toolInput(event));
				if (rawPath) pendingActionPaths.set(toolCallId, rawPath);
			}
		}
	});

	pi.on("tool_result", (event, ctx) => {
		const action = completePendingToolAction(event, "tool_result", ctx);
		logEvent("tool_result", summarizeToolEvent(event), ctx);
		logAction("tool_result", action, ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		logEvent("tool_execution_end", summarizeToolEvent(event), ctx);
		if (
			isRecord(event) &&
			pendingActions.has(toolCallIdFromEvent(event) ?? "")
		) {
			const action = completePendingToolAction(
				event,
				"tool_execution_end",
				ctx,
			);
			logAction("tool_result", action, ctx);
		}
	});

	pi.on("user_bash", (event, ctx) => {
		const action = actionFromToolCall(
			{
				toolName: "bash",
				toolCallId: "user_bash",
				input: { command: event.command },
			},
			ctx,
		);
		logEvent("user_bash", summarizeToolEvent(event), ctx);
		logAction(String(action.action ?? "shell_command"), action, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const providerData = { payload: summarizeProviderPayload(event.payload) };
		logEvent("before_provider_request", providerData, ctx);
		logAction("provider_request", providerData, ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const responseData = summarizeValue(event) as Record<string, unknown>;
		logEvent("after_provider_response", responseData, ctx);
		logAction("provider_response", responseData, ctx);
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
		const shutdownData = summarizeValue(event) as Record<string, unknown>;
		logEvent("session_shutdown", shutdownData, ctx);
		logAction("session_end", { ...shutdownData, status: "completed" }, ctx);
		writeSummary(endedAt);
		writeActionsMarkdown(endedAt);
	});

	pi.registerCommand("audit-log", {
		description: "Show current pi-win AI audit log path",
		handler: (_args, ctx) => {
			if (safeEnsureAuditPaths(ctx)) {
				const paths = {
					auditActionsPath,
					auditActionsMarkdownPath,
					auditSummaryPath,
					auditEventsPath: RAW_EVENTS ? auditEventsPath : undefined,
				};
				logEvent("audit_log_command", paths, ctx);
				logAction("audit_log_command", paths, ctx);
				writeActionsMarkdown();
			}
			return Promise.resolve();
		},
	});
}
