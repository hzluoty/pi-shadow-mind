import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "../src/summaries.js";

describe("summarizeToolResult", () => {
  it("summarizes known read tool by line count", () => {
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text: "line1\nline2\nline3" }], isError: false });
    expect(summary).toBe("3 read · line1");
  });

  it("prefixes error status", () => {
    const summary = summarizeToolResult({ toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true });
    expect(summary).toMatch(/^error · /);
  });

  it("generic summarizer reports block type and scale, never content", () => {
    const summary = summarizeToolResult({ toolName: "custom-tool", content: [{ type: "text", text: "secret content that must not leak" }, { type: "image", data: "..." }] });
    expect(summary).toBe("1 text · 1 image");
    expect(summary).not.toContain("secret");
  });

  it("generic summarizer reports string scale for plain content", () => {
    const summary = summarizeToolResult({ toolName: "custom-tool", content: "hello world" });
    expect(summary).toBe("text · 11 chars");
  });

  it("generic summarizer handles empty and missing content", () => {
    expect(summarizeToolResult({ toolName: "custom-tool", content: [] })).toBe("empty result");
    expect(summarizeToolResult({ toolName: "custom-tool", content: undefined })).toBe("no output");
    expect(summarizeToolResult({ toolName: "custom-tool", content: null })).toBe("null");
  });

  it("truncates oversized single-line previews to stay bounded", () => {
    const huge = `${"A".repeat(50_000)}TAIL_SECRET`;
    const summary = summarizeToolResult({
      toolName: "read",
      content: [{ type: "text", text: huge }],
      isError: false,
    });
    expect(summary.length).toBeLessThanOrEqual(135);
    expect(summary).toMatch(/^1 read · A+…$/);
    expect(summary).not.toContain("TAIL_SECRET");
  });
});
