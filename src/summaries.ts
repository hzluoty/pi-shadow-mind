interface ContentBlock { type?: string; text?: string; [key: string]: unknown }
interface ToolResultLike { toolName?: string; content?: unknown; isError?: boolean }

type Summarizer = (result: ToolResultLike) => string;

const summarizers = new Map<string, Summarizer>([
  ["read", (result) => summarizeLines(result, "read")],
  ["grep", (result) => summarizeLines(result, "matches")],
  ["find", (result) => summarizeLines(result, "paths")],
  ["ls", (result) => summarizeLines(result, "entries")],
]);

const MAX_PREVIEW_CHARS = 120;

export function summarizeToolResult(result: ToolResultLike): string {
  const summary = summarizers.get(result.toolName ?? "")?.(result) ?? summarizeGeneric(result);
  return result.isError ? `error · ${summary}` : summary;
}

function summarizeLines(result: ToolResultLike, noun: string): string {
  const text = textContent(result.content);
  if (!text) return `0 ${noun}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rawPreview = compact(lines[0] ?? "");
  const preview = rawPreview.length > MAX_PREVIEW_CHARS
    ? `${rawPreview.slice(0, MAX_PREVIEW_CHARS - 1)}…`
    : rawPreview;
  return `${lines.length} ${noun}${preview ? ` · ${preview}` : ""}`;
}

function summarizeGeneric(result: ToolResultLike): string {
  return describeContent(result.content) ?? "no output";
}

function describeContent(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    const blocks = content.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object");
    if (!blocks.length) return "empty result";
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const type = block.type ?? "object";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`).join(" · ");
  }
  if (content === null) return "null";
  if (typeof content === "string") return `text · ${content.length} chars`;
  if (typeof content === "number" || typeof content === "boolean") return `${typeof content} · ${String(content)}`;
  if (typeof content === "object") return `object · ${Object.keys(content as Record<string, unknown>).length} keys`;
  return undefined;
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is ContentBlock => Boolean(part) && typeof part === "object" && (part as ContentBlock).type === "text")
    .map((part) => part.text ?? "").join("\n");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
