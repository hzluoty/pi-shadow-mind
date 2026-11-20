import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Canonical set of valid pi thinking levels, shared by config and registry. */
export const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

export function cleanStringArray(
  value: unknown,
  fallback: string[],
  name: string,
): string[] {
  if (value === undefined) return [...fallback];
  if (!isStringArray(value))
    throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}

export const SHADOW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

export function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || !inRange(value, min, max)) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function optionalPositiveNumber(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

export function positiveNumber(
  value: unknown,
  fallback: number,
  name: string,
): number {
  return optionalPositiveNumber(value, name) ?? fallback;
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

export function optionalNonNegativeInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function nonNegativeInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  return optionalNonNegativeInteger(value, name) ?? fallback;
}

export function stringWithFallback(
  value: unknown,
  fallback: string,
  name: string,
): string {
  if (value === undefined) return fallback;
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalNonEmptyString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  return stringWithFallback(value, "", name);
}
