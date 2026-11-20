import { randomUUID } from "node:crypto";
import {
  type SessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import {
  CompletionReview,
  type CompletionReviewRun,
} from "./completion-review.js";
import { ConfigStore } from "./config.js";
import { EntityStore } from "./entity-store.js";
import { FinalResponseBudget } from "./final-response-budget.js";
import { registerManagementTools } from "./management-tools.js";
import { resolveModel } from "./model-resolution.js";
import { ShadowRegistry } from "./registry.js";
import { ReportBatcher, formatReportBatch } from "./report-batcher.js";
import { ReportBrowser } from "./report-browser.js";
import { createRandom } from "./random.js";
import { buildShadowSessionContext } from "./acp-projection.js";
import {
  decideFinalResponse,
  decideHeartbeat,
  extractToolNames,
  shouldEvaluateFinalResponse,
  shouldEvaluateHeartbeat,
} from "./scheduler.js";
import { SessionLifetime } from "./session-lifetime.js";
import {
  ShadowRunner,
  resolveShadowTools,
  type ShadowRunResult,
} from "./shadow-runner.js";
import { waitForSettled } from "./shutdown-drain.js";
import { StatusPresenter, type StatusSnapshot } from "./status-presenter.js";
import type {
  RegistrySnapshot,
  RuntimeEvent,
  ShadowDefinition,
  ShadowReport,
} from "./types.js";
import { UsageStore } from "./usage-store.js";
import {
  addUsage,
  zeroUsage,
  type ShadowUsage,
} from "./usage.js";

const SESSION_TEARDOWN_TIMEOUT_MS = 1_000;

interface ShadowLaunch {
  ctx: ExtensionContext;
  shadow: ShadowDefinition;
  mainModel: Model<any>;
  fullModelId: string;
  context: SessionContext;
  availableTools: Set<string>;
  epoch?: number;
  completionReview?: CompletionReviewRun;
}
interface ActiveRun {
  shadow: ShadowDefinition;
  epoch: number;
  completionReview?: CompletionReviewRun;
}

interface PendingFinalRun extends Omit<ShadowLaunch, "completionReview"> {
  epoch: number;
  shadowId: string;
}

export class ShadowMindRuntime {
  private readonly agentDir = getAgentDir();
  private readonly configStore = new ConfigStore(this.agentDir);
  private readonly registry = new ShadowRegistry(this.agentDir);
  private readonly entityStore = new EntityStore(
    this.registry,
    this.configStore.configPath,
  );
  private readonly runner = new ShadowRunner();
  private readonly usageStore = new UsageStore(this.agentDir);
  private readonly active = new Map<string, ActiveRun>();
  private readonly finalResponseBudget = new FinalResponseBudget();
  private readonly completionReview = new CompletionReview<PendingFinalRun>({
    currentEpoch: () => this.epoch,
    maxParallel: () => this.configStore.current.maxParallelShadows,
    activeCount: () => this.active.size,
    activeShadowIds: () =>
      new Set([...this.active.values()].map(({ shadow }) => shadow.id)),
    canLaunch: () => !this.batcher.hasPending,
    launch: (pending, review) =>
      this.launchShadow({ ...pending, completionReview: review }),
    deliver: (reports) => {
      void this.deliverSafely(reports);
    },
    onReviewCompleted: (shadowIds) =>
      this.finalResponseBudget.commit(shadowIds),
  });
  private readonly presenter = new StatusPresenter();
  private readonly reports = new ReportBrowser();
  private readonly batcher: ReportBatcher;
  private readonly sessionLifetime = new SessionLifetime();
  private epoch = 0;
  private modelCalls = 0;
  private paused = false;
  private shuttingDown = false;
  private latestContext?: ExtensionContext;
  private sessionUsage: ShadowUsage = zeroUsage();
  private completedWithFinalText = false;
  private random: () => number = Math.random;

  constructor(private readonly pi: ExtensionAPI) {
    this.batcher = new ReportBatcher(
      this.configStore.current.resultBatchWindowMs,
      (reports) => {
        this.completionReview.invalidate();
        void this.deliverSafely(reports);
      },
    );
  }

  register(): void {
    registerManagementTools(
      this.pi,
      this.entityStore,
      () => this.configStore.current,
      {
        onMutated: async (ctx) => {
          await this.refresh(ctx);
        },
      },
    );
    this.registerEvents();
    this.registerUi();
  }

  private registerEvents(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      this.shuttingDown = false;
      this.sessionLifetime.activate();
      this.latestContext = ctx;
      this.modelCalls = 0;
      this.completedWithFinalText = false;
      this.finalResponseBudget.reset();
      this.sessionUsage = zeroUsage();
      this.presenter.reset();
      this.reports.reset();
      await this.configStore.initialize();
      await this.usageStore.initialize();
      this.random = createRandom(this.configStore.current.randomSeed);
      await this.registry.initialize();
      await this.refresh(ctx);
      this.record("session-config", {
        randomSeed: this.configStore.current.randomSeed ?? "random",
      });
      this.updateStatus(ctx);
    });

    this.pi.on("input", (event, ctx) => {
      this.latestContext = ctx;
      if (event.source === "extension") return;
      this.completedWithFinalText = false;
      this.finalResponseBudget.reset();
      this.epoch += 1;
      this.abortAll("new-user-input");
      this.updateStatus(ctx);
    });

    this.pi.on("session_tree", (_event, ctx) => {
      this.latestContext = ctx;
      this.completedWithFinalText = false;
      this.finalResponseBudget.reset();
      this.epoch += 1;
      this.abortAll("session-tree");
      this.updateStatus(ctx);
    });

    this.pi.on("after_provider_response", (_event, ctx) => {
      this.latestContext = ctx;
      this.modelCalls += 1;
    });

    this.pi.on("turn_end", async (event, ctx) => {
      this.latestContext = ctx;
      const toolResults = event.toolResults ?? [];
      const executedTools = extractToolNames(toolResults);
      if (executedTools.size === 0) {
        this.record("heartbeat-skipped", {
          reason: "no-tool-activity",
          modelCalls: this.modelCalls,
        });
        return;
      }
      await this.onHeartbeat(ctx, executedTools);
    });

    this.pi.on("agent_end", (event, ctx) => {
      this.latestContext = ctx;
      this.completedWithFinalText = shouldEvaluateFinalResponse(event.messages);
    });

    this.pi.on("agent_settled", async (event, ctx) => {
      this.latestContext = ctx;
      if ((event as { aborted?: boolean } | undefined)?.aborted) {
        this.completedWithFinalText = false;
        this.epoch += 1;
        this.abortAll("user-aborted");
        this.record("final-response-skipped", { reason: "aborted" });
        this.updateStatus(ctx);
        return;
      }
      if (!this.completedWithFinalText) {
        this.record("final-response-skipped", {
          reason: "no-final-assistant-text",
        });
        return;
      }
      this.completedWithFinalText = false;
      await this.onFinalResponse(ctx);
    });

    this.pi.on("session_shutdown", async (event, ctx) => {
      this.shuttingDown = true;
      this.latestContext = ctx;
      if (
        event.reason === "quit" &&
        (ctx.mode === "print" || ctx.mode === "json")
      ) {
        await this.drainHeadless(ctx);
      }
      this.epoch += 1;
      this.abortAll("session-shutdown");
      if (this.active.size > 0) {
        const result = await waitForSettled({
          timeoutMs: SESSION_TEARDOWN_TIMEOUT_MS,
          isSettled: () => this.active.size === 0,
        });
        if (!result.settled) this.active.clear();
      }
      await this.usageStore.flush();
      this.reports.reset();
      ctx.ui.setStatus("shadow-mind", undefined);
      ctx.ui.setWidget("shadow-mind-panel", undefined);
      this.sessionLifetime.deactivate();
    });
  }

  private registerUi(): void {
    this.pi.registerCommand("shadow", {
      description: "Show Shadow Mind status, or toggle/pause/resume it",
      handler: async (args, ctx) => {
        this.latestContext = ctx;
        const command = args.trim().toLowerCase();
        if (command === "pause") {
          this.setPaused(true, ctx);
          return;
        }
        if (command === "resume") {
          this.setPaused(false, ctx);
          return;
        }
        if (command === "toggle") {
          this.setPaused(!this.paused, ctx);
          return;
        }
        if (await this.reports.handleCommand(command, ctx)) return;
        if (command === "status") {
          await this.refresh(ctx);
          ctx.ui.notify(
            this.presenter.statusLines(this.statusSnapshot()).join("\n"),
            this.presenter.hasDiagnostics(this.usageStore.error) ? "warning" : "info",
          );
        } else if (command === "hide") {
          this.presenter.hidePanel(ctx);
        } else {
          await this.refresh(ctx);
          this.presenter.togglePanel();
        }
        this.updateStatus(ctx);
      },
    });

    for (const shortcut of ["f6", "alt+s"] as const) {
      this.pi.registerShortcut(shortcut, {
        description: "Pause or resume Shadow Mind",
        handler: (ctx) => {
          this.latestContext = ctx;
          this.setPaused(!this.paused, ctx);
        },
      });
    }

    this.pi.registerMessageRenderer(
      "shadow-report",
      (message, _options, theme) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : "Shadow report";
        const prefix = theme.fg("accent", "🐙 shadow · ");
        return new Text(`${prefix}${content}`, 0, 0);
      },
    );
  }

  private async onHeartbeat(
    ctx: ExtensionContext,
    executedTools: ReadonlySet<string>,
  ): Promise<void> {
    const startEpoch = this.epoch;
    const snapshot = await this.refresh(ctx);
    if (startEpoch !== this.epoch || this.shuttingDown) {
      this.record("heartbeat-skipped", {
        reason: "superseded",
        modelCalls: this.modelCalls,
      });
      return;
    }
    const config = this.configStore.current;
    if (!shouldEvaluateHeartbeat(executedTools, config.heartbeatTools)) {
      this.record("heartbeat-skipped", {
        reason: "tool-filtered",
        modelCalls: this.modelCalls,
      });
      return;
    }
    if (this.paused || !ctx.model) {
      this.record("heartbeat-skipped", {
        reason: this.paused ? "paused" : "no-model",
        modelCalls: this.modelCalls,
      });
      return;
    }
    const fullModelId = `${ctx.model.provider}/${ctx.model.id}`;
    const decision = decideHeartbeat({
      heartbeatProbability: config.heartbeatProbability,
      availableSlots: Math.max(0, config.maxParallelShadows - this.active.size),
      shadows: snapshot.shadows,
      activeShadowIds: new Set(
        [...this.active.values()].map(({ shadow }) => shadow.id),
      ),
      mainModelId: fullModelId,
      random: this.random,
      executedTools,
    });
    this.record("heartbeat", {
      modelCalls: this.modelCalls,
      roll: decision.heartbeatRoll,
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow, roll }) => ({
        id: shadow.id,
        roll,
      })),
      ...(decision.modelFiltered.length
        ? { modelFiltered: decision.modelFiltered }
        : {}),
      ...(decision.runningExcluded.length
        ? { runningExcluded: decision.runningExcluded }
        : {}),
      ...(decision.toolFiltered.length
        ? { toolFiltered: decision.toolFiltered }
        : {}),
    });
    if (!decision.activated.length) return;

    const context = buildShadowSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
      ctx.sessionManager.getSessionFile(),
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool) => tool.name),
    );
    for (const { shadow } of decision.activated) {
      this.launchShadow({
        ctx,
        shadow,
        mainModel: ctx.model,
        fullModelId,
        context,
        availableTools,
      });
    }
  }

  private async onFinalResponse(ctx: ExtensionContext): Promise<void> {
    if (this.shuttingDown) return;
    if (this.batcher.hasPending) {
      await this.batcher.flush();
      return;
    }
    const request = this.completionReview.begin(this.epoch);
    const snapshot = await this.refresh(ctx);
    if (!this.completionReview.isCurrent(request) || this.shuttingDown) {
      this.record("final-response-skipped", { reason: "superseded" });
      return;
    }
    if (this.paused || !ctx.model) {
      this.completionReview.cancel(request);
      this.record("final-response-skipped", {
        reason: this.paused ? "paused" : "no-model",
      });
      return;
    }
    const mainModel = ctx.model;
    const fullModelId = `${mainModel.provider}/${mainModel.id}`;
    const decision = decideFinalResponse({
      shadows: snapshot.shadows,
      mainModelId: fullModelId,
      canRunFinalResponse: (shadow) => this.finalResponseBudget.canRun(shadow),
    });
    this.record("final-response", {
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow }) => shadow.id),
      ...(decision.modelFiltered.length
        ? { modelFiltered: decision.modelFiltered }
        : {}),
      ...(decision.runningExcluded.length
        ? { runningExcluded: decision.runningExcluded }
        : {}),
      ...(decision.roundFiltered.length
        ? { roundFiltered: decision.roundFiltered }
        : {}),
    });
    if (!decision.activated.length) {
      this.completionReview.schedule(request, []);
      return;
    }

    const context = buildShadowSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
      ctx.sessionManager.getSessionFile(),
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool) => tool.name),
    );
    this.completionReview.schedule(
      request,
      decision.activated.map(({ shadow }) => ({
        epoch: request.epoch,
        shadowId: shadow.id,
        ctx,
        shadow,
        mainModel,
        fullModelId,
        context,
        availableTools,
      })),
    );
  }

  private launchShadow(options: ShadowLaunch): void {
    const {
      ctx,
      shadow,
      mainModel,
      fullModelId,
      context,
      availableTools,
      completionReview,
    } = options;
    const runId = randomUUID();
    const runEpoch = options.epoch ?? this.epoch;
    const { tools, missing } = resolveShadowTools(shadow.tools, availableTools);
    const activeRun: ActiveRun = { shadow, epoch: runEpoch };
    if (completionReview) activeRun.completionReview = completionReview;
    this.active.set(runId, activeRun);
    this.record("run-start", {
      runId,
      shadowId: shadow.id,
      model:
        shadow.runWithModel ??
        this.configStore.current.defaultShadowModel ??
        fullModelId,
      ...(missing.length ? { missingTools: missing } : {}),
    });
    this.updateStatus(ctx);
    void this.runner
      .run({
        shadow: structuredClone(shadow),
        config: structuredClone(this.configStore.current),
        epoch: runEpoch,
        runId,
        cwd: ctx.cwd,
        agentDir: this.agentDir,
        mainSystemPrompt: ctx.getSystemPrompt(),
        // SAFETY: buildSessionContext returns Pi messages; ShadowRunner treats them as read-only records.
        messages: context.messages as unknown as Record<string, unknown>[],
        mainModel,
        tools,
        resolveModel: (id) => resolveModel(ctx, id),
        onModelFallback: (info) => this.record("model-fallback", info),
        modelAuthOk: (model) =>
          ctx.modelRegistry.hasConfiguredAuth(model) ||
          ctx.modelRegistry.isUsingOAuth(model),
        mainThinkingLevel: ctx.thinkingLevel,
        onReport: (report) => {
          if (completionReview) completionReview.accept(report);
          else this.acceptReport(report);
        },
      })
      .then((result) => this.handleRunEnd(runId, shadow, result))
      .catch((error) => {
        const activeRun = this.active.get(runId);
        this.active.delete(runId);
        this.completionReview.slotAvailable();
        this.completionReview.complete(activeRun?.completionReview);
        try {
          this.record("run-end", {
            runId,
            shadowId: shadow.id,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          if (this.latestContext && this.sessionLifetime.isActive) {
            this.updateStatus(this.latestContext);
          }
        } catch {
          // Error-path logging must never escalate into an unhandled rejection.
        }
      });
  }

  private handleRunEnd(
    runId: string,
    shadow: ShadowDefinition,
    result: ShadowRunResult,
  ): void {
    const activeRun = this.active.get(runId);
    this.active.delete(runId);
    this.completionReview.slotAvailable();
    try {
      const persisted = this.usageStore.add(result.usage);
      if (activeRun?.epoch !== this.epoch) {
        if (this.latestContext && this.sessionLifetime.isActive) {
          this.updateStatus(this.latestContext);
        }
        return;
      }
      this.sessionUsage = addUsage(this.sessionUsage, result.usage);
      this.presenter.recordRun(shadow.name, result);
      this.record("run-end", { runId, shadowId: shadow.id, ...result });
      if (this.latestContext && this.sessionLifetime.isActive) {
        this.updateStatus(this.latestContext);
      }
      void persisted
        .then(() => {
          if (this.latestContext && this.sessionLifetime.isActive) {
            this.updateStatus(this.latestContext);
          }
        })
        .catch(() => {});
    } finally {
      this.completionReview.complete(activeRun?.completionReview);
    }
  }

  /** Deliver a report batch and own the returned promise (SessionLifetime.run rethrows non-stale errors). */
  private deliverSafely(reports: readonly ShadowReport[]): Promise<void> {
    return this.deliverReports(reports).catch((error) => {
      try {
        this.record("report-delivery-error", {
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Error-path logging must never escalate into an unhandled rejection.
      }
    });
  }

  private acceptReport(report: ShadowReport): void {
    if (report.epoch !== this.epoch) return;
    this.batcher.add(report);
  }

  private async deliverReports(
    reports: readonly ShadowReport[],
  ): Promise<void> {
    const current = reports.filter((report) => report.epoch === this.epoch);
    if (!current.length) return;
    const content = formatReportBatch(current);
    const delivered = this.sessionLifetime.run(() => {
      const idle = this.latestContext?.isIdle() ?? true;
      this.pi.sendMessage(
        {
          customType: "shadow-report",
          content,
          display: true,
          details: {
            reports: current.map(({ shadowId, runId }) => ({
              shadowId,
              runId,
            })),
          },
        },
        { triggerTurn: true, deliverAs: idle ? "followUp" : "steer" },
      );
    });
    if (delivered) {
      this.record("report-delivered", {
        runIds: current.map((report) => report.runId),
        count: current.length,
      });
      this.reports.add(current);
    }
  }

  private async refresh(ctx: ExtensionContext): Promise<RegistrySnapshot> {
    const config = await this.configStore.reload();
    const registry = await this.registry.load();
    this.batcher.setWindow(config.config.resultBatchWindowMs);
    this.presenter.setRegistrySnapshot(registry.shadows.length, [
      ...(config.error ? [`config: ${config.error}`] : []),
      ...registry.diagnostics.map(
        (item) => `${item.filePath}: ${item.message}`,
      ),
    ]);
    this.updateStatus(ctx);
    return registry;
  }

  private abortAll(reason: string): void {
    this.runner.abortAll();
    this.completionReview.invalidate();
    this.batcher.clear();
    this.record("runs-aborted", { reason, count: this.active.size });
  }

  private async drainHeadless(ctx: ExtensionContext): Promise<void> {
    if (this.active.size === 0 && !this.batcher.hasPending) return;
    const timeoutMs =
      this.configStore.current.headlessDrainTimeoutSeconds * 1000;
    this.record("headless-drain-start", {
      timeoutMs,
      active: this.active.size,
    });
    const result = await waitForSettled({
      timeoutMs,
      isSettled: () =>
        this.active.size === 0 &&
        !this.batcher.hasPending &&
        ctx.isIdle() &&
        !ctx.hasPendingMessages(),
    });
    this.record(
      result.settled ? "headless-drain-complete" : "headless-drain-timeout",
      {
        durationMs: result.durationMs,
        active: this.active.size,
      },
    );
    if (!result.settled) this.abortAll("headless-drain-timeout");
  }

  private record(kind: string, data?: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      at: new Date().toISOString(),
      kind,
      epoch: this.epoch,
      data,
    };
    this.presenter.recordEvent(event);
    this.sessionLifetime.run(() =>
      this.pi.appendEntry("shadow-mind-event", event),
    );
  }

  private setPaused(paused: boolean, ctx: ExtensionContext): void {
    this.paused = paused;
    if (paused) this.abortAll("paused");
    ctx.ui.notify(
      paused ? "Shadow Mind paused" : "Shadow Mind resumed",
      "info",
    );
    this.updateStatus(ctx);
  }

  private updateStatus(ctx: ExtensionContext): void {
    this.sessionLifetime.run(() => {
      this.presenter.update(ctx, this.statusSnapshot());
    });
  }

  private statusSnapshot(): StatusSnapshot {
    return {
      paused: this.paused,
      activeCount: this.active.size,
      config: this.configStore.current,
      sessionUsage: this.sessionUsage,
      lifetimeUsage: this.usageStore.current,
      usageError: this.usageStore.error,
    };
  }
}
