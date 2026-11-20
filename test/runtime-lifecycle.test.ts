import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalResponseBudget } from "../src/final-response-budget.js";
import type { ReportBatcher } from "../src/report-batcher.js";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowRunResult } from "../src/shadow-runner.js";
import type { StatusPresenter } from "../src/status-presenter.js";
import type { RegistrySnapshot, ShadowDefinition } from "../src/types.js";
import { zeroUsage, type ShadowUsage } from "../src/usage.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

interface RuntimeInternals {
  active: Map<string, { shadow: ShadowDefinition; epoch: number; completionReview?: { accept: (r: unknown) => void } }>;
  epoch: number;
  sessionUsage: ShadowUsage;
  usageStore: {
    add: (usage: ShadowUsage) => Promise<void>;
  };
  completionReview: {
    schedule: (...args: unknown[]) => boolean;
    invalidate: () => void;
    complete: (run?: unknown) => void;
  };
  runner: {
    run: (...args: unknown[]) => Promise<ShadowRunResult>;
  };
  batcher: ReportBatcher;
  refresh: (ctx: ExtensionContext) => Promise<RegistrySnapshot>;
  onFinalResponse: (ctx: ExtensionContext) => Promise<void>;
  finalResponseBudget: FinalResponseBudget;
  registerEvents: () => void;
  onHeartbeat: (
    ctx: ExtensionContext,
    executedTools: ReadonlySet<string>,
  ) => Promise<void>;
  presenter: StatusPresenter;
  sessionLifetime: { activate: () => void; deactivate: () => void; isActive: boolean };
  latestContext?: ExtensionContext;
  updateStatus: (ctx: ExtensionContext) => void;
  handleRunEnd: (
    runId: string,
    shadow: ShadowDefinition,
    result: ShadowRunResult,
  ) => void;
}

const shadow: ShadowDefinition = {
  id: "shadow-1",
  name: "Review",
  enabled: true,
  debug: false,
  activationProbability: 1,
  trigger: ["heartbeat"],
  activeForModels: [],
  tools: [],
  activationTools: [],
  prompt: "Review",
  filePath: "review.md",
};

afterEach(() => {
  vi.useRealTimers();
});

function createRuntimeHarness() {
  const handlers = new Map<string, EventHandler>();
  const runtime = new ShadowMindRuntime({
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    },
    getAllTools: () => [],
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI);
  const internals = runtime as unknown as RuntimeInternals;
  return { handlers, internals };
}

describe("ShadowMindRuntime session lifecycle", () => {
  it.each(["reload", "new", "resume", "fork"])(
    "bounds %s session shutdown and detaches an unsettled old run",
    async (reason) => {
      vi.useFakeTimers();
      const { handlers, internals } = createRuntimeHarness();
      internals.active.set("old-run", { shadow, epoch: 0 });
      internals.registerEvents();

      const context = {
        mode: "interactive",
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
        },
      } as unknown as ExtensionContext;
      const shutdown = handlers.get("session_shutdown");
      expect(shutdown).toBeDefined();

      const pending = shutdown!({ reason }, context);
      await vi.advanceTimersByTimeAsync(999);
      expect(internals.active.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(internals.active.size).toBe(0);
    },
  );

  it("runs final-response scheduling only after final assistant text", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [],
      diagnostics: [],
    });
    internals.registerEvents();
    const agentEnd = handlers.get("agent_end");
    const agentSettled = handlers.get("agent_settled");
    const context = {} as ExtensionContext;

    await agentEnd!(
      {
        messages: [
          { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        ],
      },
      context,
    );
    await agentSettled!({}, context);
    expect(internals.refresh).not.toHaveBeenCalled();

    await agentEnd!(
      {
        messages: [
          { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
        ],
      },
      context,
    );
    await agentSettled!({ aborted: true }, context);
    expect(internals.refresh).not.toHaveBeenCalled();

    await agentEnd!(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
      context,
    );
    expect(internals.refresh).not.toHaveBeenCalled();
    await agentSettled!({ aborted: false }, context);
    expect(internals.refresh).toHaveBeenCalledOnce();
  });

  it("aborts running shadows and bumps epoch on aborted agent_settled", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [],
      diagnostics: [],
    });
    internals.active.set("hb-run", { shadow, epoch: 0 });
    internals.registerEvents();
    const context = {} as ExtensionContext;

    await handlers.get("agent_end")!(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
      context,
    );
    await handlers.get("agent_settled")!({ aborted: true }, context);

    expect(internals.epoch).toBe(1);
    expect(internals.refresh).not.toHaveBeenCalled();
    expect(
      internals.presenter.recentEvents.some(
        (event) =>
          event.kind === "runs-aborted" && event.data?.reason === "user-aborted",
      ),
    ).toBe(true);
    expect(internals.presenter.recentEvents.at(-1)).toMatchObject({
      kind: "final-response-skipped",
      data: { reason: "aborted" },
    });
  });

  it("does not consume a round for an invalidated queued final review", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.active.set("heartbeat-a", { shadow, epoch: 0 });
    internals.active.set("heartbeat-b", { shadow, epoch: 0 });
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);
    expect(internals.finalResponseBudget.used(finalShadow.id)).toBe(0);

    internals.completionReview.invalidate();
    await internals.onFinalResponse(context);

    expect(internals.presenter.recentEvents.at(-1)?.data?.activated).toEqual([
      finalShadow.id,
    ]);
  });

  it("does not consume a round if review is invalidated while running", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.runner.run = vi.fn(
      () => new Promise<ShadowRunResult>(() => undefined),
    );
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);
    expect(internals.finalResponseBudget.used(finalShadow.id)).toBe(0);

    internals.completionReview.invalidate();
    await internals.onFinalResponse(context);

    expect(internals.presenter.recentEvents.at(-1)?.data?.activated).toEqual([
      finalShadow.id,
    ]);
  });

  it("flushes pending reports and skips scheduling when batcher has pending reports", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.batcher.add({
      shadowId: "heartbeat",
      shadowName: "heartbeat",
      content: "issue found",
      epoch: 0,
      runId: "run-hb",
    });
    expect(internals.batcher.hasPending).toBe(true);

    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);

    expect(schedule).not.toHaveBeenCalled();
    expect(internals.batcher.hasPending).toBe(false);
  });

  it("limits final-response rounds per Shadow until new user input", async () => {
    const { handlers, internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.runner.run = vi.fn().mockResolvedValue({
      shadowId: finalShadow.id,
      reason: "silent",
      durationMs: 10,
      usage: zeroUsage(),
    });
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.registerEvents();
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const finalEvent = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    };

    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);
    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);

    expect(
      schedule.mock.calls.filter(([, jobs]) => (jobs as unknown[]).length > 0),
    ).toHaveLength(1);
    expect(internals.finalResponseBudget.used(finalShadow.id)).toBe(1);
    expect(internals.finalResponseBudget.canRun(finalShadow)).toBe(false);

    handlers.get("input")!({ source: "interactive" }, context);
    expect(internals.finalResponseBudget.used(finalShadow.id)).toBe(0);
    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);

    expect(
      schedule.mock.calls.filter(([, jobs]) => (jobs as unknown[]).length > 0),
    ).toHaveLength(2);
  });

  it("abandons a final-review start superseded by new input during refresh", async () => {
    const { handlers, internals } = createRuntimeHarness();
    let finishRefresh: ((snapshot: RegistrySnapshot) => void) | undefined;
    internals.refresh = vi.fn(
      () =>
        new Promise<RegistrySnapshot>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.registerEvents();
    const context = {} as ExtensionContext;

    await handlers.get("agent_end")!(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
      context,
    );
    const pending = handlers.get("agent_settled")!(
      {},
      context,
    ) as Promise<void>;
    handlers.get("input")!({ source: "interactive" }, context);
    finishRefresh!({ shadows: [], diagnostics: [] });
    await pending;

    expect(schedule).not.toHaveBeenCalled();
  });

  it("persists a stale run without adding it to the new session quota", async () => {
    const runtime = new ShadowMindRuntime({} as ExtensionAPI);
    const internals = runtime as unknown as RuntimeInternals;
    const persisted: ShadowUsage[] = [];
    internals.usageStore.add = async (usage) => {
      persisted.push(usage);
    };
    internals.epoch = 2;
    internals.active.set("old-run", { shadow, epoch: 1 });
    const usage = zeroUsage();
    usage.requests = 1;
    usage.input = 42;
    usage.totalTokens = 42;

    internals.handleRunEnd("old-run", shadow, runResult(usage));

    expect(persisted).toEqual([usage]);
    expect(internals.sessionUsage).toEqual(zeroUsage());
    expect(internals.presenter.recentRuns).toHaveLength(0);
  });

  it("updates status when a stale run finishes and still completes CompletionReview if recording throws", () => {
    const { internals } = createRuntimeHarness();
    internals.sessionLifetime.activate();
    const setStatus = vi.fn();
    const context = {
      ui: { setStatus, setWidget: vi.fn() },
    } as unknown as ExtensionContext;
    internals.latestContext = context;
    internals.epoch = 2;
    const review = { accept: vi.fn() };
    const completeSpy = vi.spyOn(internals.completionReview, "complete");
    internals.usageStore.add = vi.fn().mockResolvedValue(undefined);
    internals.active.set("old-run", { shadow, epoch: 1, completionReview: review });

    internals.handleRunEnd("old-run", shadow, runResult(zeroUsage()));
    expect(setStatus).toHaveBeenCalled();
    expect(completeSpy).toHaveBeenCalledWith(review);

    const recordRunSpy = vi.spyOn(internals.presenter, "recordRun").mockImplementationOnce(() => {
      throw new Error("presenter boom");
    });
    internals.active.set("cur-run", { shadow, epoch: 2, completionReview: review });
    expect(() => internals.handleRunEnd("cur-run", shadow, runResult(zeroUsage()))).toThrow("presenter boom");
    expect(completeSpy).toHaveBeenCalledTimes(2);
    recordRunSpy.mockRestore();
  });

  it("abandons an in-flight heartbeat superseded by new input or shutdown during refresh", async () => {
    const { handlers, internals } = createRuntimeHarness();
    let finishRefresh: ((snapshot: RegistrySnapshot) => void) | undefined;
    internals.refresh = vi.fn(
      () =>
        new Promise<RegistrySnapshot>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    internals.runner.run = vi.fn();
    internals.registerEvents();
    const context = {
      model: { provider: "openai", id: "gpt" },
    } as ExtensionContext;

    const pendingTurn = handlers.get("turn_end")!(
      { toolResults: [{ toolName: "read" }] },
      context,
    ) as Promise<void>;
    handlers.get("input")!({ source: "interactive" }, context);
    finishRefresh!({ shadows: [shadow], diagnostics: [] });
    await pendingTurn;

    expect(internals.runner.run).not.toHaveBeenCalled();
    expect(internals.presenter.recentEvents.at(-1)).toMatchObject({
      kind: "heartbeat-skipped",
      data: { reason: "superseded" },
    });

    // Also test shutdown during refresh while epoch has not yet incremented (e.g. headless drain).
    const pendingShutdownTurn = handlers.get("turn_end")!(
      { toolResults: [{ toolName: "read" }] },
      context,
    ) as Promise<void>;
    const shutdownPromise = handlers.get("session_shutdown")!(
      { reason: "quit" },
      { mode: "interactive", ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext,
    ) as Promise<void>;
    finishRefresh!({ shadows: [shadow], diagnostics: [] });
    await pendingShutdownTurn;
    await shutdownPromise;
    expect(internals.runner.run).not.toHaveBeenCalled();
  });

  it("aborts running shadows and refreshes status on session_tree and input", () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.sessionLifetime.activate();
    const setStatus = vi.fn();
    const context = {
      ui: { setStatus, setWidget: vi.fn() },
    } as unknown as ExtensionContext;
    internals.registerEvents();

    internals.active.set("branch-run", { shadow, epoch: 0 });
    handlers.get("session_tree")!({}, context);
    expect(internals.epoch).toBe(1);
    expect(internals.presenter.recentEvents.at(-1)).toMatchObject({
      kind: "runs-aborted",
      data: { reason: "session-tree" },
    });
    expect(setStatus).toHaveBeenCalled();

    setStatus.mockClear();
    handlers.get("input")!({ source: "interactive" }, context);
    expect(internals.epoch).toBe(2);
    expect(setStatus).toHaveBeenCalledOnce();
  });

  it("clears previous session events and diagnostics on session_start", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.registerEvents();
    internals.presenter.recordEvent({ at: new Date().toISOString(), kind: "run-end", epoch: 0, data: { reason: "error" } });
    internals.presenter.recordRun(shadow.name, runResult(zeroUsage()));
    expect(internals.presenter.recentEvents).toHaveLength(1);

    (internals as unknown as { configStore: { initialize: () => Promise<void> } }).configStore.initialize = vi.fn().mockResolvedValue(undefined);
    (internals as unknown as { usageStore: { initialize: () => Promise<void> } }).usageStore.initialize = vi.fn().mockResolvedValue(undefined);
    (internals as unknown as { registry: { initialize: () => Promise<void> } }).registry.initialize = vi.fn().mockResolvedValue(undefined);
    internals.refresh = vi.fn().mockResolvedValue({ shadows: [], diagnostics: [] });

    await handlers.get("session_start")!(
      { reason: "new" },
      { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext,
    );
    expect(internals.presenter.recentRuns).toHaveLength(0);
    expect(internals.presenter.recentEvents.map((e) => e.kind)).toEqual(["session-config"]);
  });

  it("skips text-only turns and forwards completed tool names for refreshed evaluation", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.onHeartbeat = vi.fn();
    internals.registerEvents();
    const turnEnd = handlers.get("turn_end")!;
    const context = {} as ExtensionContext;

    await turnEnd({ toolResults: [] }, context);
    expect(internals.onHeartbeat).not.toHaveBeenCalled();
    expect(internals.presenter.recentEvents.at(-1)?.data?.reason).toBe(
      "no-tool-activity",
    );

    await turnEnd(
      {
        toolResults: [
          { toolName: "read" },
          { toolName: "bash" },
          { toolName: "read" },
        ],
      },
      context,
    );
    expect(internals.onHeartbeat).toHaveBeenCalledExactlyOnceWith(
      context,
      new Set(["read", "bash"]),
    );
  });
});

function runResult(usage: ShadowUsage): ShadowRunResult {
  return {
    reason: "aborted",
    durationMs: 100,
    toolNames: [],
    missingTools: [],
    toolCalls: 0,
    toolFailures: 0,
    toolStats: [],
    usage,
  };
}
