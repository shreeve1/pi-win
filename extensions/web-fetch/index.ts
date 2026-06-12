import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function stripHtml(html: string): string {
	let text = html;
	text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/p>/gi, "\n\n");
	text = text.replace(/<\/h[1-6]>/gi, "\n\n");
	text = text.replace(/<\/li>/gi, "\n");
	text = text.replace(/<\/tr>/gi, "\n");
	text = text.replace(/<hr[^>]*>/gi, "\n---\n");
	text = text.replace(
		/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		"[$2]($1)",
	);
	text = text.replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, "**$2**");
	text = text.replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, "*$2*");
	text = text.replace(
		/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
		"\n```\n$1\n```\n",
	);
	text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
	text = text.replace(/<[^>]+>/g, "");
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function truncate(text: string, maxLines = 500, maxBytes = 100000): string {
	const lines = text.split("\n");
	let result =
		lines.length > maxLines
			? `${lines.slice(0, maxLines).join("\n")}\n... truncated ${lines.length - maxLines} lines`
			: text;
	if (Buffer.byteLength(result, "utf8") > maxBytes) {
		result = `${result.slice(0, maxBytes)}\n... truncated (max bytes reached)`;
	}
	return result;
}

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stringParam(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

// Block SSRF against the client LAN. The agent runs as SYSTEM, so private,
// loopback, and link-local targets (esp. the 169.254.169.254 metadata IP) must
// be refused before a fetch is attempted.
function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.includes(":")) {
		if (host === "::1" || host === "::") return true;
		if (host.startsWith("fe80:")) return true; // link-local
		if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique-local fc00::/7
		return false;
	}
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 0 || a === 127 || a === 10) return true; // 0/8, loopback, 10/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
	if (a === 192 && b === 168) return true; // 192.168/16
	if (a === 169 && b === 254) return true; // 169.254/16 link-local
	return false;
}

function numberParam(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export default function (pi: ExtensionAPI) {
	const SERPER_KEY = process.env.SERPER_API_KEY || "";
	const HAS_SERPER = SERPER_KEY.length > 0;

	if (HAS_SERPER) {
		pi.registerTool({
			name: "web_search",
			label: "Web Search",
			description:
				"Search the web using Google via Serper API. Returns titles, URLs, and snippets.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query" },
					numResults: {
						type: "number",
						description: "Max results (default 10, max 20)",
					},
				},
				required: ["query"],
			},
			promptGuidelines: [
				"Use web_search to find information not available locally.",
				"After searching, use web_fetch to read 2-3 relevant URLs for full content.",
				"Good for: error codes, known issues, documentation, version compatibility.",
			],
			async execute(
				_id: string,
				params: { query?: unknown; numResults?: unknown },
			) {
				const query = stringParam(params.query);
				if (!query) return textResult("Search error: query is required", true);

				try {
					const num = Math.min(numberParam(params.numResults) || 10, 20);
					const resp = await fetch("https://google.serper.dev/search", {
						method: "POST",
						headers: {
							"X-API-KEY": SERPER_KEY,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ q: query, num, gl: "us", hl: "en" }),
					});
					if (!resp.ok) {
						return textResult(
							`Search failed: ${resp.status} ${resp.statusText}`,
							true,
						);
					}

					const data = await resp.json();
					const lines: string[] = [];
					if (data.answerBox) {
						lines.push(
							`Answer: ${data.answerBox.answer || data.answerBox.snippet}`,
						);
						lines.push("");
					}
					if (data.knowledgeGraph) {
						lines.push(`Knowledge Graph: ${data.knowledgeGraph.title}`);
						if (data.knowledgeGraph.description) {
							lines.push(`  ${data.knowledgeGraph.description}`);
						}
						lines.push("");
					}
					const results = data.organic || [];
					for (let i = 0; i < results.length; i++) {
						const r = results[i];
						lines.push(`${i + 1}. ${r.title}`);
						lines.push(`   ${r.link}`);
						if (r.snippet) lines.push(`   ${r.snippet}`);
						lines.push("");
					}
					return textResult(lines.join("\n"));
				} catch (error: unknown) {
					return textResult(`Search error: ${errorMessage(error)}`, true);
				}
			},
		});
	}

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract its content as plain text or markdown. No JavaScript rendering.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL to fetch" },
				format: {
					type: "string",
					enum: ["text", "raw"],
					description: "Output format (default: text)",
				},
				timeout: {
					type: "number",
					description: "Timeout in seconds (default 30)",
				},
			},
			required: ["url"],
		},
		promptGuidelines: [
			"Use web_fetch to read full page content from a URL.",
			"Good for: documentation pages, KB articles, error code references.",
			"Does NOT render JavaScript. Use for static content only.",
		],
		async execute(
			_id: string,
			params: { url?: unknown; format?: unknown; timeout?: unknown },
		) {
			const url = stringParam(params.url);
			if (!url) return textResult("Fetch error: url is required", true);

			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return textResult("Fetch error: invalid URL", true);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return textResult(
					"Fetch blocked: only http(s) URLs are allowed",
					true,
				);
			}
			if (isBlockedHost(parsed.hostname)) {
				return textResult(
					`Fetch blocked: ${parsed.hostname} is a private, loopback, or link-local address`,
					true,
				);
			}

			try {
				const timeout = (numberParam(params.timeout) || 30) * 1000;
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);

				const resp = await fetch(url, {
					signal: controller.signal,
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Accept: "text/html,application/xhtml+xml,text/plain",
					},
				});
				clearTimeout(timer);

				if (!resp.ok) {
					return textResult(
						`Fetch failed: ${resp.status} ${resp.statusText}`,
						true,
					);
				}

				const body = await resp.text();
				if (stringParam(params.format) === "raw") {
					return textResult(truncate(body));
				}

				return textResult(truncate(stripHtml(body)));
			} catch (error: unknown) {
				return textResult(`Fetch error: ${errorMessage(error)}`, true);
			}
		},
	});
}
