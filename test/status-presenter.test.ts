import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { StatusPresenter } from "../src/status-presenter.js";
import { zeroUsage } from "../src/usage.js";

describe("StatusPresenter", () => {
  it("renders status bar warnings, panel lines, and resets session buffers", () => {
    const presenter = new StatusPresenter();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ctx = { ui: { setStatus, setWidget } } as unknown as ExtensionContext;

    presenter.setRegistrySnapshot(2, ["bad.md: missing YAML frontmatter"]);
    presenter.recordEvent({
      at: "2026-01-01T12:00:00.000Z",
      kind: "run-end",
      epoch: 1,
      data: { reason: "error", error: "boom" },
    });
    presenter.recordRun(
      "Reviewer",
      {
        reason: "error",
        error: "boom",
        durationMs: 12,
        toolNames: [],
        missingTools: [],
        toolCalls: 0,
        toolFailures: 0,
        toolStats: [],
        usage: zeroUsage(),
      },
      "2026-01-01T12:00:00.000Z",
    );
    expect(presenter.togglePanel()).toBe(true);

    presenter.update(ctx, {
      paused: false,
      activeCount: 1,
      config: DEFAULT_CONFIG,
      sessionUsage: zeroUsage(),
      lifetimeUsage: zeroUsage(),
    });

    expect(setStatus).toHaveBeenCalledWith("shadow-mind", "🐙 1 · 0 · $0 !");
    expect(setWidget).toHaveBeenCalledOnce();
    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.join("\n")).toContain("definitions: 2 valid · 1 invalid");
    expect(lines.join("\n")).toContain("diagnostic: bad.md: missing YAML frontmatter");
    expect(lines.join("\n")).toContain("run-end boom");

    presenter.hidePanel(ctx);
    expect(presenter.panelVisible).toBe(false);
    expect(setWidget).toHaveBeenLastCalledWith("shadow-mind-panel", undefined);

    presenter.reset();
    expect(presenter.recentEvents).toEqual([]);
    expect(presenter.recentRuns).toEqual([]);
    expect(presenter.diagnostics).toEqual([]);
    expect(presenter.shadowCount).toBe(0);
  });
});
