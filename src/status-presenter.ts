import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ShadowRunResult } from "./shadow-runner.js";
import type { RuntimeEvent, ShadowConfig } from "./types.js";
import {
  formatUsageCost,
  formatUsageDetail,
  formatUsageSummary,
  formatUsageTokens,
  type ShadowUsage,
} from "./usage.js";

export interface RecentRunEntry {
  shadowName: string;
  completedAt: string;
  result: ShadowRunResult;
}

export interface StatusSnapshot {
  paused: boolean;
  activeCount: number;
  config: ShadowConfig;
  sessionUsage: ShadowUsage;
  lifetimeUsage: ShadowUsage;
  usageError?: string;
}

const MAX_RECENT_EVENTS = 20;
const MAX_RECENT_RUNS = 5;

/** Owns UI-facing diagnostic/history buffers and renders the status bar + panel. */
export class StatusPresenter {
  panelVisible = false;
  shadowCount = 0;
  diagnostics: string[] = [];
  readonly recentEvents: RuntimeEvent[] = [];
  readonly recentRuns: RecentRunEntry[] = [];

  reset(): void {
    this.recentRuns.length = 0;
    this.recentEvents.length = 0;
    this.diagnostics = [];
    this.shadowCount = 0;
  }

  recordEvent(event: RuntimeEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
  }

  recordRun(
    shadowName: string,
    result: ShadowRunResult,
    completedAt = new Date().toISOString(),
  ): void {
    this.recentRuns.push({ shadowName, completedAt, result });
    if (this.recentRuns.length > MAX_RECENT_RUNS) {
      this.recentRuns.shift();
    }
  }

  setRegistrySnapshot(shadowCount: number, diagnostics: string[]): void {
    this.shadowCount = shadowCount;
    this.diagnostics = diagnostics;
  }

  hasDiagnostics(usageError?: string): boolean {
    return this.allDiagnostics(usageError).length > 0;
  }

  togglePanel(): boolean {
    this.panelVisible = !this.panelVisible;
    return this.panelVisible;
  }

  hidePanel(ctx?: ExtensionContext): void {
    this.panelVisible = false;
    ctx?.ui.setWidget("shadow-mind-panel", undefined);
  }

  update(ctx: ExtensionContext, snapshot: StatusSnapshot): void {
    const diagnostics = this.allDiagnostics(snapshot.usageError);
    const warning =
      diagnostics.length || this.hasRecentRunErrors() ? " !" : "";
    const usage = `${formatUsageTokens(snapshot.sessionUsage.totalTokens)} · ${formatUsageCost(snapshot.sessionUsage.cost.total)}`;
    ctx.ui.setStatus(
      "shadow-mind",
      snapshot.paused
        ? `🐙 Paused · ${usage}${warning}`
        : `🐙 ${snapshot.activeCount} · ${usage}${warning}`,
    );
    if (this.panelVisible) {
      ctx.ui.setWidget("shadow-mind-panel", this.statusLines(snapshot), {
        placement: "aboveEditor",
      });
    }
  }

  statusLines(snapshot: StatusSnapshot): string[] {
    const { config } = snapshot;
    const diagnostics = this.allDiagnostics(snapshot.usageError);
    return [
      `🐙 Shadow Mind · ${snapshot.paused ? "paused" : "active"} · running ${snapshot.activeCount}/${config.maxParallelShadows}`,
      `heartbeat ${formatNumber(config.heartbeatProbability)} · batch ${config.resultBatchWindowMs}ms · timeout ${config.defaultShadowTimeoutSeconds}s · drain ${config.headlessDrainTimeoutSeconds}s · thinking ${config.defaultThinkingLevel}`,
      `definitions: ${this.shadowCount} valid · ${this.diagnostics.length} invalid`,
      formatUsageDetail("session", snapshot.sessionUsage),
      `usage lifetime · ${formatUsageSummary(snapshot.lifetimeUsage)}`,
      ...this.recentRuns
        .slice(-3)
        .map(
          ({ shadowName, completedAt, result }) =>
            `recent run · ${formatCompletedAt(completedAt)} · ${shadowName} · ${result.reason} · ${formatUsageSummary(result.usage)}`,
        ),
      ...diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
      ...this.recentEvents.slice(-5).map((event) => {
        const failed =
          event.kind === "run-end" &&
          (event.data?.reason === "error" || event.data?.reason === "timeout");
        const detail = failed
          ? ` ${event.data?.error ?? event.data?.reason}`
          : "";
        return `${new Date(event.at).toLocaleTimeString("en-GB", { hour12: false })} ${event.kind}${detail}`;
      }),
      "Shortcut: Alt+S toggle · Commands: /shadow toggle | pause | resume | status | hide | reports",
    ];
  }

  private allDiagnostics(usageError?: string): string[] {
    return usageError
      ? [...this.diagnostics, `usage: ${usageError}`]
      : this.diagnostics;
  }

  private hasRecentRunErrors(): boolean {
    return this.recentEvents
      .slice(-3)
      .some(
        (event) =>
          event.kind === "run-end" &&
          (event.data?.reason === "error" || event.data?.reason === "timeout"),
      );
  }
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatCompletedAt(completedAt: string): string {
  return new Date(completedAt).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
