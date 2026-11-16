import { describe, expect, it, vi } from "vitest";
import { ReportBatcher } from "../src/report-batcher.js";

describe("ReportBatcher", () => {
  it("combines reports inside the window", async () => {
    vi.useFakeTimers();
    const delivered: string[][] = [];
    const batcher = new ReportBatcher(400, (reports) => { delivered.push(reports.map(({ content }) => content)); });
    batcher.add({ shadowId: "a", shadowName: "A", content: "one", epoch: 1, runId: "1" });
    batcher.add({ shadowId: "b", shadowName: "B", content: "two", epoch: 1, runId: "2" });
    expect(batcher.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(delivered).toEqual([["one", "two"]]);
    expect(batcher.hasPending).toBe(false);
    vi.useRealTimers();
  });

  it("contains timer-driven delivery rejections without leaking unhandledRejection", async () => {
    vi.useFakeTimers();
    const leaked: unknown[] = [];
    const listener = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const batcher = new ReportBatcher(50, async () => {
        throw new Error("delivery boom");
      });
      batcher.add({ shadowId: "a", shadowName: "A", content: "one", epoch: 1, runId: "1" });
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      await Promise.resolve();
      expect(batcher.hasPending).toBe(false);
      expect(leaked).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      vi.useRealTimers();
    }
  });
});
