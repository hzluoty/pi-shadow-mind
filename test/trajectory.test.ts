import { describe, expect, it } from "vitest";
import { serializeTrajectory } from "../src/trajectory.js";

describe("serializeTrajectory", () => {
  it("retains native compaction and branch summary payloads", () => {
    const result = serializeTrajectory([
      { role: "compactionSummary", summary: "compacted facts", tokensBefore: 100, timestamp: 0 },
      { role: "branchSummary", summary: "branch facts", fromId: "old", timestamp: 0 },
      { role: "compactionSummary", content: "legacy content" },
    ]);
    expect(result).toContain("SUMMARY: compacted facts");
    expect(result).toContain("SUMMARY: branch facts");
    expect(result).toContain("SUMMARY: legacy content");
  });

  it("renders a plain-text transcript and joins tool summaries to their calls", () => {
    const result = serializeTrajectory([
      { role: "user", content: [{ type: "text", text: "Inspect it." }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Reading now." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one\ntwo" }], isError: false },
      { role: "custom", customType: "shadow-report", content: "previous feedback" },
    ]);
    expect(result).toContain("USER: Inspect it.");
    expect(result).toContain("MAIN: Reading now.");
    expect(result).toContain('TOOL: read({"path":"a.ts"}) · 2 read · one');
    expect(result).toContain("SHADOW FEEDBACK: previous feedback");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("TOOL RESULT:");
  });

  it("emits TOOL RESULT fallback for orphaned toolResult messages with string toolCallIds", () => {
    const result = serializeTrajectory([
      { role: "user", content: "Continue after compaction" },
      { role: "toolResult", toolCallId: "orphan-call-1", toolName: "read", content: [{ type: "text", text: "line1\nline2" }], isError: false },
    ]);
    expect(result).toContain("TOOL RESULT: 2 read · line1");
  });
});
