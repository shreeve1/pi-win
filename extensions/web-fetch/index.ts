import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function stripHtml(html: string): string {
  let text = html;
  // Remove scripts and styles
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  // Convert common elements
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");
  // Links: keep text and href
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  // Bold/italic
  text = text.replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, "**$2**");
  text = text.replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, "*$2*");
  // Code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function truncate(text: string, maxLines = 500, maxBytes = 100000): string {
  const lines = text.split("\n");
  let result = lines.length > maxLines
    ? lines.slice(0, maxLines).join("\n") + `\n... truncated ${lines.length - maxLines} lines`
    : text;
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, maxBytes) + "\n... truncated (max bytes reached)";
  }
  return result;
}

export default function (pi: ExtensionAPI) {
  const SERPER_KEY = process.env.SERPER_API_KEY || "";
  const HAS_SERPER = SERPER_KEY.length > 0;

  // web_search - Google search via Serper API
  if (HAS_SERPER) {
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description: "Search the web using Google via Serper API. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          numResults: { type: "number", description: "Max results (default 10, max 20)" },
        },
        required: ["query"],
      },
      promptGuidelines: [
        "Use web_search to find information not available locally.",
        "After searching, use web_fetch to read 2-3 relevant URLs for full content.",
        "Good for: error codes, known issues, documentation, version compatibility.",
      ],
      async execute(_id: string, params: { query: string; numResults?: number }) {
        try {
          const num = Math.min(params.numResults || 10, 20);
          const resp = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": SERPER_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: params.query, num, gl: "us", hl: "en" }),
          });
          if (!resp.ok) {
            return {
              content: [{ type: "text" as const, text: `Search failed: ${resp.status} ${resp.statusText}` }],
              isError: true,
            };
          }
          const data = await resp.json();
          const lines: string[] = [];
          // Answer box
          if (data.answerBox) {
            lines.push(`Answer: ${data.answerBox.answer || data.answerBox.snippet}`);
            lines.push("");
          }
          // Knowledge graph
          if (data.knowledgeGraph) {
            lines.push(`Knowledge Graph: ${data.knowledgeGraph.title}`);
            if (data.knowledgeGraph.description) lines.push(`  ${data.knowledgeGraph.description}`);
            lines.push("");
          }
          // Organic results
          const results = data.organic || [];
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            lines.push(`${i + 1}. ${r.title}`);
            lines.push(`   ${r.link}`);
            if (r.snippet) lines.push(`   ${r.snippet}`);
            lines.push("");
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${e.message}` }],
            isError: true,
          };
        }
      },
    });
  }

  // web_fetch - fetch URL content as text/markdown
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page and extract its content as plain text or markdown. No JavaScript rendering.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        format: { type: "string", enum: ["text", "raw"], description: "Output format (default: text)" },
        timeout: { type: "number", description: "Timeout in seconds (default 30)" },
      },
      required: ["url"],
    },
    promptGuidelines: [
      "Use web_fetch to read full page content from a URL.",
      "Good for: documentation pages, KB articles, error code references.",
      "Does NOT render JavaScript. Use for static content only.",
    ],
    async execute(_id: string, params: { url: string; format?: string; timeout?: number }) {
      try {
        const timeout = (params.timeout || 30) * 1000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const resp = await fetch(params.url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,text/plain",
          },
        });
        clearTimeout(timer);

        if (!resp.ok) {
          return {
            content: [{ type: "text" as const, text: `Fetch failed: ${resp.status} ${resp.statusText}` }],
            isError: true,
          };
        }

        const body = await resp.text();
        const format = params.format || "text";

        if (format === "raw") {
          return { content: [{ type: "text" as const, text: truncate(body) }] };
        }

        // text format: strip HTML
        const extracted = stripHtml(body);
        return { content: [{ type: "text" as const, text: truncate(extracted) }] };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${e.message}` }],
          isError: true,
        };
      }
    },
  });
}
