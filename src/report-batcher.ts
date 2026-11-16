import type { ShadowReport } from "./types.js";

export class ReportBatcher {
  private reports: ShadowReport[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private deliveries = 0;

  constructor(private windowMs: number, private readonly deliver: (reports: ShadowReport[]) => void | Promise<void>) {}

  setWindow(windowMs: number): void {
    this.windowMs = windowMs;
  }

  add(report: ShadowReport): void {
    this.reports.push(report);
    if (this.timer) return;
    // Delivery failures are contained here: a fire-and-forget timer callback
    // must not leak an unhandled rejection into the host process.
    this.timer = setTimeout(() => void this.flush().catch(() => {}), this.windowMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.reports.length) return;
    const batch = this.reports;
    this.reports = [];
    this.deliveries += 1;
    try {
      await this.deliver(batch);
    } finally {
      this.deliveries -= 1;
    }
  }

  get hasPending(): boolean {
    return this.reports.length > 0 || this.timer !== undefined || this.deliveries > 0;
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.reports = [];
  }
}

export function formatReportBatch(reports: readonly ShadowReport[]): string {
  return reports.map((report) => `[${report.shadowName} / ${report.shadowId}]\n${report.content}`).join("\n\n");
}
