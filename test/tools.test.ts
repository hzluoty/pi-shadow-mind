import { describe, expect, it, vi } from "vitest";
import { resolveModel } from "../src/model-resolution.js";
import { buildRunResult, resolveRunModel, resolveRunThinkingLevel, resolveShadowTools, toolMetrics } from "../src/shadow-runner.js";
import { zeroUsage } from "../src/usage.js";

const fullRegistry = new Set(["read", "ffgrep", "fffind", "write", "bash", "edit", "custom-tool", "report_to_main"]);

describe("resolveShadowTools", () => {
  it("keeps defaults, whitelist additions, and the built-in report tool", () => {
    const { tools, missing } = resolveShadowTools(["write"], fullRegistry);
    expect(tools).toEqual(["read", "ffgrep", "fffind", "write", "report_to_main"]);
    expect(missing).toEqual([]);
  });

  it("deduplicates overlapping names", () => {
    const { tools } = resolveShadowTools(["read", "write", "read"], fullRegistry);
    expect(tools).toEqual(["read", "ffgrep", "fffind", "write", "report_to_main"]);
  });

  it("drops whitelist tools missing from the session registry and reports them", () => {
    const { tools, missing } = resolveShadowTools(["nonexistent-tool", "bash"], fullRegistry);
    expect(tools).toEqual(["read", "ffgrep", "fffind", "bash", "report_to_main"]);
    expect(missing).toEqual(["nonexistent-tool"]);
  });

  it("grants every tool currently available when the whitelist contains a wildcard", () => {
    const { tools, missing } = resolveShadowTools(["*"], fullRegistry);
    expect(tools).toEqual([...fullRegistry]);
    expect(missing).toEqual([]);
  });

  it("always keeps report_to_main with wildcard access when it is not available", () => {
    const { tools, missing } = resolveShadowTools(["*"], new Set(["custom-tool"]));
    expect(tools).toEqual(["custom-tool", "report_to_main"]);
    expect(missing).toEqual([]);
  });

  it("always keeps report_to_main even when it is not in the available set", () => {
    const { tools, missing } = resolveShadowTools([], new Set(["read"]));
    expect(tools).toEqual(["read", "report_to_main"]);
    expect(missing).toEqual(["ffgrep", "fffind"]);
  });
});

describe("toolMetrics", () => {
  it("breaks tool usage down per called tool", () => {
    const metrics = toolMetrics([
      { role: "toolResult", toolName: "read", isError: false },
      { role: "toolResult", toolName: "read", isError: true },
      { role: "toolResult", toolName: "grep", isError: false },
      { role: "assistant" },
    ]);
    expect(metrics.toolCalls).toBe(3);
    expect(metrics.toolFailures).toBe(1);
    expect(metrics.toolStats).toEqual([
      { tool: "read", calls: 2, failures: 1 },
      { tool: "grep", calls: 1, failures: 0 },
    ]);
  });
});

describe("buildRunResult", () => {
  const session = {
    messages: [
      { role: "toolResult", toolName: "read", isError: false }, // injected trajectory (base)
      { role: "toolResult", toolName: "grep", isError: true }, // shadow's own call
    ],
    getActiveToolNames: () => ["read", "report_to_main"],
    sessionFile: "s.jsonl",
  };

  it("counts only the shadow's own tool results after baseMessageCount", () => {
    const result = buildRunResult({ reason: "report", durationMs: 10, session: session as any, baseMessageCount: 1, missingTools: [] });
    expect(result.toolCalls).toBe(1);
    expect(result.toolFailures).toBe(1);
    expect(result.toolStats).toEqual([{ tool: "grep", calls: 1, failures: 1 }]);
    expect(result.toolNames).toEqual(["read", "report_to_main"]);
  });

  it("aggregates only post-baseline assistant usage, excluding messages without usage", () => {
    const result = buildRunResult({
      reason: "silent",
      durationMs: 10,
      session: {
        messages: [
          { role: "toolResult", toolName: "read", isError: false },
          {
            role: "assistant",
            usage: {
              input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000, totalTokens: 4000,
              cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
            },
          },
          {
            role: "assistant",
            usage: {
              input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
              cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
            },
          },
          { role: "assistant" },
          {
            role: "assistant",
            usage: {
              input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
              cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
            },
          },
        ],
        getActiveToolNames: () => [],
      } as any,
      baseMessageCount: 2,
      missingTools: [],
    });

    expect(result.usage).toEqual({
      requests: 2,
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 110,
      cost: { input: 0.011, output: 0.022, cacheRead: 0.033, cacheWrite: 0.044, total: 0.11 },
    });
  });

  it("always returns zero usage for early error results and omits the optional error field otherwise", () => {
    const ok = buildRunResult({ reason: "silent", durationMs: 0, session: undefined, baseMessageCount: 0, missingTools: [] });
    expect(ok.error).toBeUndefined();
    expect("error" in ok).toBe(false);
    expect(ok.usage).toEqual(zeroUsage());
    const failed = buildRunResult({ reason: "error", error: "boom", durationMs: 0, session: undefined, baseMessageCount: 0, missingTools: [] });
    expect(failed.error).toBe("boom");
    expect(failed.usage).toEqual(zeroUsage());
  });

  it("passes through the resolved thinking level", () => {
    const result = buildRunResult({ reason: "silent", durationMs: 0, session: undefined, baseMessageCount: 0, missingTools: [], thinkingLevel: "high" });
    expect(result.thinkingLevel).toBe("high");
  });
});

describe("resolveRunThinkingLevel", () => {
  const model = (thinkingLevelMap: Record<string, string | null> | undefined) => ({ provider: "p", id: "m", thinkingLevelMap }) as any;
  const request = (shadow: { thinkingLevel?: string }, mainThinkingLevel?: string) => ({
    shadow,
    config: { defaultThinkingLevel: "low" },
    mainThinkingLevel,
  }) as any;

  it("prefers the shadow's explicit level when supported", () => {
    expect(resolveRunThinkingLevel(model({ low: "low", medium: "medium", high: "high" }), request({ thinkingLevel: "high" }))).toBe("high");
  });

  it("falls back through config default then main level when the shadow level is unsupported", () => {
    // deepseek-v4-flash style map: only high/max supported
    expect(resolveRunThinkingLevel(model({ minimal: null, low: null, medium: null, high: "high" }), request({ thinkingLevel: "medium" }, "high"))).toBe("high");
  });

  it("uses the config default when no explicit level and the default is supported", () => {
    expect(resolveRunThinkingLevel(model({ low: "low", high: "high" }), request({}, "high"))).toBe("low");
  });

  it("treats a missing thinkingLevelMap as supported", () => {
    expect(resolveRunThinkingLevel(model(undefined), request({ thinkingLevel: "medium" }))).toBe("medium");
  });

  it("fails only when no candidate or map entry is supported", () => {
    expect(() => resolveRunThinkingLevel(model({ minimal: null, low: null, medium: null, high: null }), request({ thinkingLevel: "medium" }, "high"))).toThrow(/no supported thinking level/);
  });

  it("degrades to the highest supported map level when all candidates are unsupported", () => {
    expect(
      resolveRunThinkingLevel(
        model({ low: "low", medium: null, high: "high", xhigh: null, max: "max", minimal: null, off: null }),
        { shadow: {}, config: { defaultThinkingLevel: "xhigh" }, mainThinkingLevel: "xhigh" } as any,
      ),
    ).toBe("max");
    expect(
      resolveRunThinkingLevel(
        model({ low: "low", high: "high", max: null, medium: null, xhigh: null, minimal: null, off: null }),
        { shadow: {}, config: { defaultThinkingLevel: "xhigh" }, mainThinkingLevel: "xhigh" } as any,
      ),
    ).toBe("high");
  });
});

describe("resolveModel and resolveRunModel", () => {
  const glm = { provider: "magpie", id: "autoclaw-cn/zai_glm-5.3-flash" } as any;
  const deepseek = { provider: "magpie", id: "commandcode-plan/deepseek/deepseek-v4.1-flash" } as any;
  const noAuth = { provider: "baishan", id: "GLM-5.3-Flash" } as any;
  const duplicateUnauthed = { provider: "other", id: "shared/model" } as any;
  const duplicateAuthed = { provider: "magpie", id: "shared/model" } as any;
  const all = [glm, deepseek, noAuth, duplicateUnauthed, duplicateAuthed];
  const authed = new Set([glm, deepseek, duplicateAuthed]);
  const ctx = {
    modelRegistry: {
      getAll: () => all,
      find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: (model: any) => authed.has(model),
      isUsingOAuth: () => false,
    },
  };

  it("resolves bare model ids that contain slashes and prefers authenticated candidates", () => {
    expect(resolveModel(ctx, glm.id)).toBe(glm);
    expect(resolveModel(ctx, `${glm.provider}/${glm.id}`)).toBe(glm);
    expect(resolveModel(ctx, "shared/model")).toBe(duplicateAuthed);
    expect(resolveModel(ctx, "nope/nope")).toBeUndefined();
  });

  it("falls back to mainModel with reason when configured shadow model is missing or unauthenticated", () => {
    const fallbacks: Array<{ requested: string; reason: string; used: string }> = [];
    const base = {
      shadow: {},
      config: { defaultShadowModel: `${glm.provider}/${glm.id}` },
      mainModel: deepseek,
      resolveModel: (id: string) => resolveModel(ctx, id),
      modelAuthOk: (model: any) => ctx.modelRegistry.hasConfiguredAuth(model),
      onModelFallback: vi.fn((info) => fallbacks.push(info)),
    } as any;

    expect(resolveRunModel(base)).toBe(glm);
    expect(fallbacks).toHaveLength(0);

    expect(resolveRunModel({ ...base, config: { defaultShadowModel: "autoclaw-cn/missing" } })).toBe(deepseek);
    expect(fallbacks.pop()).toEqual({
      requested: "autoclaw-cn/missing",
      reason: "not-found",
      used: `${deepseek.provider}/${deepseek.id}`,
    });

    expect(resolveRunModel({ ...base, config: { defaultShadowModel: `${noAuth.provider}/${noAuth.id}` } })).toBe(deepseek);
    expect(fallbacks.pop()).toEqual({
      requested: `${noAuth.provider}/${noAuth.id}`,
      reason: "no-auth",
      used: `${deepseek.provider}/${deepseek.id}`,
    });

    expect(resolveRunModel({ ...base, shadow: { runWithModel: `${glm.provider}/${glm.id}` }, config: {} })).toBe(glm);
    expect(resolveRunModel({ ...base, config: {} })).toBe(deepseek);
  });
});
