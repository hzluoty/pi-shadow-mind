import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USAGE_LOCK_OWNER_FILE = "owner";
const USAGE_LOCK_OPERATION_DIRECTORY = ".operation";

export interface UsageFileLockTiming {
  retryMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
}

interface ResolvedUsageFileLockTiming {
  retryMs: number;
  staleMs: number;
  heartbeatMs: number;
  acquireTimeoutMs: number;
  releaseTimeoutMs: number;
}

interface UsageLockOwner {
  token: string;
  pid: number;
}

interface UsageLockState {
  owner?: UsageLockOwner;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export async function acquireUsageFileLock(
  usagePath: string,
  timing: UsageFileLockTiming = {},
): Promise<() => Promise<void>> {
  const resolved = resolveTiming(timing);
  const lockPath = `${usagePath}.lock`;
  const owner = { token: randomUUID(), pid: process.pid };
  const deadline = Date.now() + resolved.acquireTimeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverStaleUsageLock(lockPath, resolved);
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring usage file lock: ${lockPath}`);
      }
      await delay(resolved.retryMs);
      continue;
    }

    try {
      await writeOwner(lockPath, owner);
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return startLease(lockPath, owner, resolved);
  }
}

function startLease(
  lockPath: string,
  owner: UsageLockOwner,
  timing: ResolvedUsageFileLockTiming,
): () => Promise<void> {
  let stopped = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (stopped) return;
      const current = await readUsageLockState(lockPath);
      if (!current || current.owner?.token !== owner.token) {
        stopped = true;
        return;
      }
      const now = new Date();
      await utimes(join(lockPath, USAGE_LOCK_OWNER_FILE), now, now);
    }).catch(() => undefined);
  }, timing.heartbeatMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeat;
    await releaseUsageLock(lockPath, owner.token, timing);
  };
}

async function recoverStaleUsageLock(
  lockPath: string,
  timing: ResolvedUsageFileLockTiming,
): Promise<void> {
  const observed = await readUsageLockState(lockPath);
  if (!observed || !isRecoverableUsageLock(observed, timing.staleMs)) return;

  const operationPath = join(lockPath, USAGE_LOCK_OPERATION_DIRECTORY);
  if (!await claimUsageLockOperation(operationPath, timing)) return;
  let renamed = false;
  try {
    const current = await readUsageLockState(lockPath);
    if (!current
      || !sameUsageLock(current, observed)
      || !isRecoverableUsageLock(current, timing.staleMs)) return;

    const abandonedPath = `${lockPath}.${randomUUID()}.stale`;
    try {
      await rename(lockPath, abandonedPath);
      renamed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || isTransientRenameError(code)) return;
      throw error;
    }
    await rm(abandonedPath, { recursive: true, force: true });
  } finally {
    if (!renamed) {
      await rm(operationPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function releaseUsageLock(
  lockPath: string,
  token: string,
  timing: ResolvedUsageFileLockTiming,
): Promise<void> {
  const operationPath = join(lockPath, USAGE_LOCK_OPERATION_DIRECTORY);
  const deadline = Date.now() + timing.releaseTimeoutMs;
  while (true) {
    const observed = await readUsageLockState(lockPath);
    if (!observed || observed.owner?.token !== token) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out releasing usage file lock: ${lockPath}`);
    }
    if (!await claimUsageLockOperation(operationPath, timing)) {
      await delay(timing.retryMs);
      continue;
    }
    let renamed = false;
    try {
      const current = await readUsageLockState(lockPath);
      if (!current || current.owner?.token !== token) return;

      const releasedPath = `${lockPath}.${token}.released`;
      try {
        await rename(lockPath, releasedPath);
        renamed = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (isTransientRenameError(code)) {
          await delay(timing.retryMs);
          continue;
        }
        throw error;
      }
      await rm(releasedPath, { recursive: true, force: true });
      return;
    } finally {
      if (!renamed) {
        await rm(operationPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

async function claimUsageLockOperation(
  operationPath: string,
  timing: ResolvedUsageFileLockTiming,
): Promise<boolean> {
  const owner = { token: randomUUID(), pid: process.pid };
  try {
    await mkdir(operationPath);
    try {
      await writeOwner(operationPath, owner);
    } catch (error) {
      await rm(operationPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  const observed = await readUsageLockState(operationPath);
  if (!observed || !isRecoverableUsageLock(observed, timing.staleMs)) return false;
  const abandonedPath = `${operationPath}.${randomUUID()}.stale`;
  try {
    await rename(operationPath, abandonedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || isTransientRenameError(code)) return false;
    throw error;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return false;
}

async function writeOwner(path: string, owner: UsageLockOwner): Promise<void> {
  await writeFile(join(path, USAGE_LOCK_OWNER_FILE), JSON.stringify(owner), {
    encoding: "utf8",
    flag: "wx",
  });
}

async function readUsageLockState(lockPath: string): Promise<UsageLockState | undefined> {
  let lock;
  try {
    lock = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const ownerPath = join(lockPath, USAGE_LOCK_OWNER_FILE);
    const [raw, ownerFile] = await Promise.all([readFile(ownerPath, "utf8"), stat(ownerPath)]);
    return {
      owner: parseOwner(raw),
      mtimeMs: ownerFile.mtimeMs,
      dev: lock.dev,
      ino: lock.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { mtimeMs: lock.mtimeMs, dev: lock.dev, ino: lock.ino };
  }
}

function parseOwner(raw: string): UsageLockOwner | undefined {
  try {
    const value = JSON.parse(raw) as { token?: unknown; pid?: unknown };
    if (typeof value.token !== "string"
      || !value.token
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0) return undefined;
    return { token: value.token, pid: value.pid as number };
  } catch {
    return undefined;
  }
}

function isRecoverableUsageLock(lock: UsageLockState, staleMs: number): boolean {
  return Date.now() - lock.mtimeMs >= staleMs && !isProcessAlive(lock.owner?.pid);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameUsageLock(left: UsageLockState, right: UsageLockState): boolean {
  return left.owner !== undefined && right.owner !== undefined
    ? left.owner.token === right.owner.token
    : left.owner === right.owner && left.dev === right.dev && left.ino === right.ino;
}

function isTransientRenameError(code: string | undefined): boolean {
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function resolveTiming(timing: UsageFileLockTiming): ResolvedUsageFileLockTiming {
  return {
    retryMs: timing.retryMs ?? 25,
    staleMs: timing.staleMs ?? 30_000,
    heartbeatMs: timing.heartbeatMs ?? 10_000,
    acquireTimeoutMs: timing.acquireTimeoutMs ?? 10_000,
    releaseTimeoutMs: timing.releaseTimeoutMs ?? 10_000,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
