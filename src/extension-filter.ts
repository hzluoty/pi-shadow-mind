import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = canonicalPath(fileURLToPath(import.meta.url));
const SELF_FALLBACK_PATH = normalizeCase(normalize(resolve(fileURLToPath(import.meta.url))));
const SELF_DIRECTORIES = new Set([dirname(SELF_PATH), dirname(SELF_FALLBACK_PATH)]);
const SELF_ENTRIES = new Set(["index.ts", "index.js"]);

/** This plugin's own extension entry, which a Shadow session must never load. */
export function isSelfExtension(candidate: string): boolean {
  if (isVirtualExtensionPath(candidate)) return false;
  const fallback = normalizeCase(normalize(resolve(candidate)));
  const canonical = canonicalPath(candidate);
  if (fallback === SELF_FALLBACK_PATH || canonical === SELF_PATH) return true;
  return (
    (SELF_ENTRIES.has(basename(fallback)) && SELF_DIRECTORIES.has(dirname(fallback))) ||
    (SELF_ENTRIES.has(basename(canonical)) && SELF_DIRECTORIES.has(dirname(canonical)))
  );
}

/** Directories to inspect above an extension file when looking for its package root. */
const PACKAGE_LOOKUP_DEPTH = 4;
/** `index.js` and friends name nothing: almost every package entry is called that. */
const GENERIC_ENTRY_FILE = /^index\.[^.]+$/;
const packageNameCache = new Map<string, { name: string; directory: string } | undefined>();

/**
 * Every name an `excluded_extensions` entry may use for one extension.
 *
 * Only the file path is available here: `extensionsOverride` runs before Pi
 * attaches package metadata to the loaded extensions, so `sourceInfo` still
 * holds its "local/temporary" placeholder. The owning package is therefore read
 * from the nearest `package.json` above the file:
 *
 * - packaged extensions: the package name (`pi-experiencev2`, `@scope/name`),
 *   the package directory name and its absolute path;
 * - single-file extensions: the file name with and without suffix
 *   (`herdr-agent-state`, `herdr-agent-state.ts`).
 *
 * The absolute file path always counts. A bare `index.js` / `index.ts` never
 * becomes a name, so one generic entry cannot wipe out every packaged extension.
 */
export function extensionIdentifiers(resolvedPath: string): Set<string> {
  if (isVirtualExtensionPath(resolvedPath)) {
    return new Set([resolvedPath, stripScheme(resolvedPath)]);
  }
  const normalized = normalizeCase(normalize(resolve(resolvedPath)));
  const canonical = canonicalPath(resolvedPath);
  const identifiers = new Set([normalized, canonical]);
  const owner = findPackage(dirname(canonical)) ?? findPackage(dirname(normalized));
  if (owner) {
    identifiers.add(owner.name);
    identifiers.add(basename(owner.directory));
    identifiers.add(owner.directory);
    identifiers.add(normalizeCase(owner.directory));
  }
  const fileName = basename(normalized);
  if (!GENERIC_ENTRY_FILE.test(fileName)) {
    identifiers.add(fileName);
    identifiers.add(fileName.replace(/\.[^.]+$/, ""));
  }
  return identifiers;
}

/**
 * Build the predicate for `excluded_extensions`: true means this extension stays
 * out of the Shadow session. Entries are exact identifiers, not patterns; blank
 * entries and an empty list exclude nothing.
 */
export function createExtensionExcluder(entries: readonly string[]): (resolvedPath: string) => boolean {
  const wanted = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    wanted.add(trimmed);
    wanted.add(stripScheme(trimmed));
    if (looksLikePath(trimmed)) {
      const expanded = expandHome(trimmed);
      wanted.add(normalizeCase(normalize(resolve(expanded))));
      wanted.add(canonicalPath(expanded));
    }
  }
  if (wanted.size === 0) return () => false;
  return (resolvedPath) => {
    for (const identifier of extensionIdentifiers(resolvedPath)) {
      if (wanted.has(identifier)) return true;
    }
    return false;
  };
}

/**
 * Nearest `package.json` with a name at or above `directory`. The search stays
 * inside the package: it never crosses a `node_modules` directory or the home
 * directory, and gives up after a few levels.
 */
function findPackage(directory: string): { name: string; directory: string } | undefined {
  if (packageNameCache.has(directory)) return packageNameCache.get(directory);
  const home = canonicalPath(homedir());
  let current = directory;
  let found: { name: string; directory: string } | undefined;
  for (let depth = 0; depth < PACKAGE_LOOKUP_DEPTH; depth += 1) {
    if (basename(current) === "node_modules" || normalizeCase(current) === home) break;
    const name = readPackageName(current);
    if (name) {
      found = { name, directory: current };
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  packageNameCache.set(directory, found);
  return found;
}

function readPackageName(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function stripScheme(source: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(source)) return source;
  return source.replace(/^[a-z][a-z0-9+.-]+:/i, "");
}

function expandHome(entry: string): string {
  return entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")
    ? resolve(homedir(), entry.slice(2))
    : entry;
}

function isVirtualExtensionPath(path: string): boolean {
  if (path.startsWith("<") && path.endsWith(">")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(path);
}

function looksLikePath(entry: string): boolean {
  if (entry.startsWith("@")) return false;
  return (
    entry === "~" ||
    entry.startsWith("~/") ||
    entry.startsWith("~\\") ||
    entry.startsWith(".") ||
    /^[a-zA-Z]:[\\/]/.test(entry) ||
    entry.includes("/") ||
    entry.includes("\\")
  );
}

function canonicalPath(filePath: string): string {
  const resolved = normalize(resolve(filePath));
  let target = resolved;
  try {
    target = realpathSync(resolved);
  } catch {
    // Non-existent path in unit tests or deleted locations keeps the resolved path.
  }
  return normalizeCase(normalize(target));
}

function normalizeCase(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}
