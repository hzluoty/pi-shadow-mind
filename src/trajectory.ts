import { summarizeToolResult } from "./summaries.js";

type MessageLike = { role?: string; content?: unknown; [key: string]: unknown };

export function serializeTrajectory(messages: readonly MessageLike[]): string {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, summarizeToolResult(message));
    }
  }

  const lines: string[] = [];
  const matchedToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      appendText(lines, "USER", message.content);
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        appendText(lines, "MAIN", message.content);
        continue;
      }
      for (const block of message.content) {
        if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
        const item = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
        if (item.type === "text" && item.text) lines.push(`MAIN: ${item.text}`);
        if (item.type === "toolCall" && item.name) {
          const call = `${item.name}(${compactJson(item.arguments)})`;
          const result = item.id ? results.get(item.id) : undefined;
          if (item.id && result !== undefined) matchedToolCallIds.add(item.id);
          lines.push(`TOOL: ${call}${result ? ` · ${result}` : ""}`);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !matchedToolCallIds.has(message.toolCallId)) {
        lines.push(`TOOL RESULT: ${summarizeToolResult(message)}`);
      }
      continue;
    }
    if (message.role === "custom" && message.customType === "shadow-report") {
      appendText(lines, "SHADOW FEEDBACK", message.content);
      continue;
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      appendText(lines, "SUMMARY", message.summary ?? message.content);
    }
  }
  return `<main-agent-trajectory>\n${lines.join("\n")}\n</main-agent-trajectory>`;
}

function isThinkingBlock(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { type?: string }).type === "thinking";
}

function appendText(lines: string[], label: string, content: unknown): void {
  const text = extractText(content);
  if (text) lines.push(`${label}: ${text}`);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
