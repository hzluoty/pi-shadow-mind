import { basename } from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ShadowConfig, ShadowDefinition, ShadowTrigger } from "./types.js";
import { parseConfig } from "./config.js";
import { describeShadow, type EntityStore } from "./entity-store.js";
import { resolveModel } from "./model-resolution.js";

const ID = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" });
const THINKING = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const TRIGGER = Type.Union([
  Type.Literal("heartbeat"),
  Type.Literal("final_response"),
]);
const SHADOW_FIELDS = {
  name: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  debug: Type.Optional(Type.Boolean()),
  activation_probability: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1 }),
  ),
  trigger: Type.Optional(Type.Array(TRIGGER)),
  active_for_models: Type.Optional(Type.Array(Type.String())),
  run_with_model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(THINKING),
  timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  final_response_rounds: Type.Optional(Type.Integer({ minimum: 0 })),
  activation_tools: Type.Optional(Type.Array(Type.String())),
  tools: Type.Optional(Type.Array(Type.String())),
  prompt: Type.Optional(Type.String()),
};

export interface ManagementToolHooks {
  onMutated?: (ctx: ExtensionContext) => Promise<void> | void;
}

export function registerManagementTools(
  pi: ExtensionAPI,
  store: EntityStore,
  getConfig: () => ShadowConfig,
  hooks: ManagementToolHooks = {},
): void {
  pi.registerTool(listTool(store));
  pi.registerTool(createTool(store, hooks));
  pi.registerTool(updateTool(store, hooks));
  pi.registerTool(toggleTool(store, true, hooks));
  pi.registerTool(toggleTool(store, false, hooks));
  pi.registerTool(deleteTool(store, hooks));
  pi.registerTool(configReadTool(store));
  pi.registerTool(configWriteTool(store, getConfig, hooks));
}

function listTool(store: EntityStore): ToolDefinition {
  return tool(
    "list_shadows",
    "List Shadows",
    "List all valid globally configured Shadow Minds.",
    Type.Object({}),
    async () => {
      const shadows = await store.list();
      return textResult(
        shadows.length
          ? shadows.map(describeShadow).join("\n")
          : "No Shadow Minds configured.",
      );
    },
  );
}

function createTool(store: EntityStore, hooks: ManagementToolHooks): ToolDefinition {
  return tool(
    "create_shadow",
    "Create Shadow",
    "Create a global Shadow Mind definition after user confirmation.",
    Type.Object({ id: ID, ...SHADOW_FIELDS, prompt: Type.String() }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params as Record<string, unknown>;
      const prepared = await store.previewCreate(toDraft(raw));
      if (
        !(await confirm(
          ctx,
          "Create Shadow Mind",
          formatCreateConfirmation(prepared.definition),
        ))
      )
        return textResult("Cancelled.");
      const shadow = await store.commitCreate(prepared);
      await hooks.onMutated?.(ctx);
      return textResult(`Created ${describeShadow(shadow)}`);
    },
  );
}

function updateTool(store: EntityStore, hooks: ManagementToolHooks): ToolDefinition {
  return tool(
    "update_shadow",
    "Update Shadow",
    "Update a global Shadow Mind definition after user confirmation. The id is immutable.",
    Type.Object({ id: ID, ...SHADOW_FIELDS }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params as Record<string, unknown>;
      const id = String(raw.id);
      const prepared = await store.previewUpdate(id, toPatch(raw));
      const diff = formatShadowDiff(prepared.current, prepared.definition);
      if (diff.length === 0) {
        return textResult(`No changes for ${id}.`);
      }
      if (
        !(await confirm(
          ctx,
          "Update Shadow Mind",
          `Apply changes to ${id} (${basename(prepared.filePath)})?\n\n${diff.join("\n")}`,
        ))
      )
        return textResult("Cancelled.");
      const shadow = await store.commitUpdate(prepared);
      await hooks.onMutated?.(ctx);
      return textResult(`Updated ${describeShadow(shadow)}`);
    },
  );
}

function toggleTool(
  store: EntityStore,
  enabled: boolean,
  hooks: ManagementToolHooks,
): ToolDefinition {
  const action = enabled ? "enable" : "disable";
  return tool(
    `${action}_shadow`,
    `${enabled ? "Enable" : "Disable"} Shadow`,
    `${enabled ? "Enable" : "Disable"} a global Shadow Mind after user confirmation.`,
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String((params as { id: string }).id);
      const current = await store.get(id);
      if (
        !(await confirm(
          ctx,
          `${enabled ? "Enable" : "Disable"} Shadow Mind`,
          `${action} ${id} (${current.name}, currently ${current.enabled ? "enabled" : "disabled"})?`,
        ))
      )
        return textResult("Cancelled.");
      const updated = await store.setEnabled(id, enabled);
      await hooks.onMutated?.(ctx);
      return textResult(describeShadow(updated));
    },
  );
}

function deleteTool(store: EntityStore, hooks: ManagementToolHooks): ToolDefinition {
  return tool(
    "delete_shadow",
    "Delete Shadow",
    "Delete a Shadow Mind definition after user confirmation. Debug logs are retained.",
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String((params as { id: string }).id);
      const current = await store.get(id);
      if (
        !(await confirm(
          ctx,
          "Delete Shadow Mind",
          `Delete ${id} (${current.name}, file ${basename(current.filePath)})? Its debug logs will be kept.`,
        ))
      )
        return textResult("Cancelled.");
      await store.delete(id);
      await hooks.onMutated?.(ctx);
      return textResult(`Deleted ${id}; logs were retained.`);
    },
  );
}

function configReadTool(store: EntityStore): ToolDefinition {
  return tool(
    "get_shadow_config",
    "Get Shadow Config",
    "Read the global Shadow Mind runtime configuration.",
    Type.Object({}),
    async () => textResult(await store.readConfig()),
  );
}

function configWriteTool(
  store: EntityStore,
  getConfig: () => ShadowConfig,
  hooks: ManagementToolHooks,
): ToolDefinition {
  return tool(
    "update_shadow_config",
    "Update Shadow Config",
    "Update global Shadow Mind runtime configuration after user confirmation.",
    Type.Object({
      heartbeat_probability: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1 }),
      ),
      heartbeat_tools: Type.Optional(Type.Array(Type.String())),
      max_parallel_shadows: Type.Optional(Type.Integer({ minimum: 1 })),
      default_shadow_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 }),
      ),
      headless_drain_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 }),
      ),
      result_batch_window_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      excluded_extensions: Type.Optional(Type.Array(Type.String())),
      default_shadow_model: Type.Optional(Type.String()),
      default_thinking_level: Type.Optional(THINKING),
      random_seed: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
      ),
    }),
    async (_id, params, _signal, _update, ctx) => {
      const current = await store.readParsedConfig(getConfig());
      const raw = params as Record<string, unknown>;
      const next = parseConfig({
        heartbeat_probability:
          raw.heartbeat_probability ?? current.heartbeatProbability,
        heartbeat_tools: raw.heartbeat_tools ?? current.heartbeatTools,
        max_parallel_shadows:
          raw.max_parallel_shadows ?? current.maxParallelShadows,
        default_shadow_timeout_seconds:
          raw.default_shadow_timeout_seconds ??
          current.defaultShadowTimeoutSeconds,
        headless_drain_timeout_seconds:
          raw.headless_drain_timeout_seconds ??
          current.headlessDrainTimeoutSeconds,
        result_batch_window_ms:
          raw.result_batch_window_ms ?? current.resultBatchWindowMs,
        excluded_extensions:
          raw.excluded_extensions ?? current.excludedExtensions,
        default_shadow_model:
          raw.default_shadow_model ?? current.defaultShadowModel,
        default_thinking_level:
          raw.default_thinking_level ?? current.defaultThinkingLevel,
        random_seed: raw.random_seed ?? current.randomSeed,
      });
      if (
        raw.default_shadow_model !== undefined &&
        next.defaultShadowModel &&
        ctx.modelRegistry &&
        !resolveModel(ctx, next.defaultShadowModel)
      ) {
        throw new Error(
          `unknown shadow model: ${next.defaultShadowModel}. Pass provider/modelId, e.g. openai/gpt-5-mini.`,
        );
      }
      const diff = formatConfigDiff(current, next);
      if (diff.length === 0) {
        return textResult("No changes to Shadow Mind config.");
      }
      if (
        !(await confirm(
          ctx,
          "Update Shadow Config",
          `Apply config changes?\n\n${diff.join("\n")}\n\n${JSON.stringify(next, null, 2)}`,
        ))
      )
        return textResult("Cancelled.");
      await store.writeConfig(next);
      await hooks.onMutated?.(ctx);
      return textResult("Shadow Mind config updated.");
    },
  );
}

function tool(
  name: string,
  label: string,
  description: string,
  parameters: any,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return { name, label, description, parameters, execute };
}

async function confirm(
  ctx: Parameters<ToolDefinition["execute"]>[4],
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI)
    throw new Error(
      "This write requires a UI confirmation, but no dialog-capable UI is available.",
    );
  return ctx.ui.confirm(title, message);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function toDraft(raw: Record<string, unknown>) {
  return { id: String(raw.id), ...toPatch(raw) };
}

function toPatch(raw: Record<string, unknown>) {
  return {
    name: raw.name as string | undefined,
    enabled: raw.enabled as boolean | undefined,
    debug: raw.debug as boolean | undefined,
    activationProbability: raw.activation_probability as number | undefined,
    trigger: raw.trigger as ShadowTrigger[] | undefined,
    activeForModels: raw.active_for_models as string[] | undefined,
    runWithModel: raw.run_with_model as string | undefined,
    thinkingLevel: raw.thinking_level as any,
    timeoutSeconds: raw.timeout_seconds as number | undefined,
    finalResponseRounds: raw.final_response_rounds as number | undefined,
    activationTools: raw.activation_tools as string[] | undefined,
    tools: raw.tools as string[] | undefined,
    prompt: raw.prompt as string | undefined,
  };
}

function formatCreateConfirmation(shadow: ShadowDefinition): string {
  const toolsText = shadow.tools.length ? shadow.tools.join(", ") : "(default read-only)";
  const lines = [
    `Create ${shadow.id} (${shadow.name}) in ${basename(shadow.filePath)}?`,
    `enabled: ${shadow.enabled}`,
    `debug: ${shadow.debug}`,
    `trigger: ${shadow.trigger.join(", ")}`,
    `activation_probability: ${shadow.activationProbability}`,
    `active_for_models: ${shadow.activeForModels.join(", ")}`,
    ...(shadow.runWithModel ? [`run_with_model: ${shadow.runWithModel}`] : []),
    ...(shadow.thinkingLevel ? [`thinking_level: ${shadow.thinkingLevel}`] : []),
    ...(shadow.timeoutSeconds !== undefined ? [`timeout_seconds: ${shadow.timeoutSeconds}`] : []),
    ...(shadow.finalResponseRounds !== undefined ? [`final_response_rounds: ${shadow.finalResponseRounds}`] : []),
    ...(shadow.activationTools.length ? [`activation_tools: ${shadow.activationTools.join(", ")}`] : []),
    `tools: ${toolsText}`,
    "",
    "prompt:",
    shadow.prompt,
  ];
  return lines.join("\n");
}

function formatShadowDiff(current: ShadowDefinition, next: ShadowDefinition): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["name", current.name, next.name],
    ["enabled", current.enabled, next.enabled],
    ["debug", current.debug, next.debug],
    ["activation_probability", current.activationProbability, next.activationProbability],
    ["trigger", current.trigger, next.trigger],
    ["active_for_models", current.activeForModels, next.activeForModels],
    ["run_with_model", current.runWithModel, next.runWithModel],
    ["thinking_level", current.thinkingLevel, next.thinkingLevel],
    ["timeout_seconds", current.timeoutSeconds, next.timeoutSeconds],
    ["final_response_rounds", current.finalResponseRounds, next.finalResponseRounds],
    ["activation_tools", current.activationTools, next.activationTools],
    ["tools", current.tools, next.tools],
  ];
  const diffs = fields
    .filter(([, oldVal, newVal]) => !sameValue(oldVal, newVal))
    .map(([name, oldVal, newVal]) => `${name}: ${formatValue(oldVal)} -> ${formatValue(newVal)}`);
  if (current.prompt !== next.prompt) {
    diffs.push(`prompt:\n--- before ---\n${current.prompt}\n--- after ---\n${next.prompt}`);
  }
  return diffs;
}

function formatConfigDiff(current: ShadowConfig, next: ShadowConfig): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["heartbeat_probability", current.heartbeatProbability, next.heartbeatProbability],
    ["heartbeat_tools", current.heartbeatTools, next.heartbeatTools],
    ["max_parallel_shadows", current.maxParallelShadows, next.maxParallelShadows],
    ["default_shadow_timeout_seconds", current.defaultShadowTimeoutSeconds, next.defaultShadowTimeoutSeconds],
    ["headless_drain_timeout_seconds", current.headlessDrainTimeoutSeconds, next.headlessDrainTimeoutSeconds],
    ["result_batch_window_ms", current.resultBatchWindowMs, next.resultBatchWindowMs],
    ["excluded_extensions", current.excludedExtensions, next.excludedExtensions],
    ["default_shadow_model", current.defaultShadowModel, next.defaultShadowModel],
    ["default_thinking_level", current.defaultThinkingLevel, next.defaultThinkingLevel],
    ["random_seed", current.randomSeed, next.randomSeed],
  ];
  return fields
    .filter(([, oldVal, newVal]) => !sameValue(oldVal, newVal))
    .map(([name, oldVal, newVal]) => `${name}: ${formatValue(oldVal)} -> ${formatValue(newVal)}`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}
