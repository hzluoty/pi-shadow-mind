import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireUsageFileLock } from "../src/usage-file-lock.js";

const TIMING = { retryMs: 5, staleMs: 40, heartbeatMs: 10 };

describe("usage file lock", () => {
  let directory: string;
  let usagePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "shadow-usage-lock-"));
    usagePath = join(directory, "usage.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("renews the owner lease while the lock is held", async () => {
    const release = await acquireUsageFileLock(usagePath, TIMING);
    const ownerPath = `${usagePath}.lock/owner`;
    const before = (await stat(ownerPath)).mtimeMs;

    await delay(30);

    expect((await stat(ownerPath)).mtimeMs).toBeGreaterThan(before);
    await release();
  });

  it("does not steal a stale lock from a live owner", async () => {
    const lockPath = `${usagePath}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner"), JSON.stringify({ token: "live", pid: process.pid }), "utf8");
    const stale = new Date(Date.now() - 1_000);
    await utimes(join(lockPath, "owner"), stale, stale);

    let acquired = false;
    const waiting = acquireUsageFileLock(usagePath, TIMING).then((release) => {
      acquired = true;
      return release;
    });
    await delay(80);
    expect(acquired).toBe(false);

    await rm(lockPath, { recursive: true });
    const release = await waiting;
    await release();
  });

  it("recovers a stale lock whose owner process has exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    expect(pid).toBeDefined();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });

    const lockPath = `${usagePath}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner"), JSON.stringify({ token: "dead", pid }), "utf8");
    const stale = new Date(Date.now() - 1_000);
    await utimes(join(lockPath, "owner"), stale, stale);

    const release = await acquireUsageFileLock(usagePath, TIMING);

    const owner = JSON.parse(await readFile(join(lockPath, "owner"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe("dead");
    await release();
  });

  it("times out with an explicit error instead of hanging forever on a live contended lock", async () => {
    const release = await acquireUsageFileLock(usagePath, TIMING);
    await expect(
      acquireUsageFileLock(usagePath, { ...TIMING, acquireTimeoutMs: 40 }),
    ).rejects.toThrow(/timed out acquiring usage file lock/);
    await release();
  });

  it("handles rapid sequential lock handoffs without deleting the next holder's lock files", async () => {
    for (let i = 0; i < 10; i += 1) {
      const first = await acquireUsageFileLock(usagePath, TIMING);
      const secondPromise = acquireUsageFileLock(usagePath, { ...TIMING, acquireTimeoutMs: 2_000 });
      await delay(2);
      await first();
      const second = await secondPromise;
      await second();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
