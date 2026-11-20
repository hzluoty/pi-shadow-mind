import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG, parseConfig, serializeConfig } from "./config.js";
import { parseShadowMarkdown, ShadowRegistry } from "./registry.js";
import type { ShadowConfig, ShadowDefinition } from "./types.js";
import { SHADOW_ID_PATTERN } from "./validation.js";

export type ShadowDraft = Partial<Omit<ShadowDefinition, "filePath">> & {
  id: string;
  prompt?: string;
};

export interface PreparedShadowWrite {
  definition: ShadowDefinition;
  source: string;
  filePath: string;
}

export interface PreparedShadowUpdate extends PreparedShadowWrite {
  current: ShadowDefinition;
}

export class EntityStore {
  constructor(
    readonly registry: ShadowRegistry,
    private readonly configPath: string,
  ) {}

  async list(): Promise<ShadowDefinition[]> {
    return (await this.registry.load()).shadows;
  }

  async get(id: string): Promise<ShadowDefinition> {
    const shadow = (await this.list()).find((candidate) => candidate.id === id);
    if (!shadow) throw new Error(`shadow not found: ${id}`);
    return shadow;
  }

  async previewCreate(draft: ShadowDraft): Promise<PreparedShadowWrite> {
    if (!SHADOW_ID_PATTERN.test(draft.id)) {
      throw new Error("id must match [a-z0-9][a-z0-9_-]*");
    }
    if ((await this.list()).some((shadow) => shadow.id === draft.id)) {
      throw new Error(`shadow already exists: ${draft.id}`);
    }
    const filePath = join(this.registry.directory, `${draft.id}.md`);
    if (await pathExists(filePath)) {
      throw new Error(`shadow file already exists: ${filePath}`);
    }
    const source = serializeShadow({
      ...draft,
      prompt: draft.prompt ?? "Describe this Shadow Mind's responsibility.",
    });
    const definition = parseShadowMarkdown(source, filePath);
    return { definition, source, filePath };
  }

  async commitCreate(prepared: PreparedShadowWrite): Promise<ShadowDefinition> {
    await writeFile(prepared.filePath, prepared.source, {
      encoding: "utf8",
      flag: "wx",
    });
    this.registry.invalidate(prepared.filePath);
    return prepared.definition;
  }

  async create(draft: ShadowDraft): Promise<ShadowDefinition> {
    const prepared = await this.previewCreate(draft);
    return this.commitCreate(prepared);
  }

  async previewUpdate(
    id: string,
    patch: Partial<Omit<ShadowDraft, "id">>,
  ): Promise<PreparedShadowUpdate> {
    const current = await this.get(id);
    const source = serializeShadow({
      ...current,
      ...definedOnly(patch),
      id,
      prompt: patch.prompt ?? current.prompt,
    });
    const definition = parseShadowMarkdown(source, current.filePath);
    return { current, definition, source, filePath: current.filePath };
  }

  async commitUpdate(prepared: PreparedShadowUpdate): Promise<ShadowDefinition> {
    await writeFile(prepared.filePath, prepared.source, { encoding: "utf8" });
    this.registry.invalidate(prepared.filePath);
    return prepared.definition;
  }

  async update(
    id: string,
    patch: Partial<Omit<ShadowDraft, "id">>,
  ): Promise<ShadowDefinition> {
    const prepared = await this.previewUpdate(id, patch);
    return this.commitUpdate(prepared);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ShadowDefinition> {
    return this.update(id, { enabled });
  }

  async delete(id: string): Promise<void> {
    const filePath = (await this.get(id)).filePath;
    await unlink(filePath);
    this.registry.invalidate(filePath);
  }

  async readConfig(): Promise<string> {
    return readFile(this.configPath, "utf8");
  }

  async readParsedConfig(fallback: ShadowConfig = DEFAULT_CONFIG): Promise<ShadowConfig> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      return parseConfig(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      throw new Error(
        `cannot read current config (${this.configPath}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async writeConfig(config: ShadowConfig): Promise<void> {
    await writeFile(this.configPath, serializeConfig(config), "utf8");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function serializeShadow(shadow: ShadowDraft): string {
  const frontmatter: Record<string, unknown> = {
    id: shadow.id,
    ...(shadow.name !== undefined ? { name: shadow.name } : {}),
    enabled: shadow.enabled ?? true,
    debug: shadow.debug ?? false,
    activation_probability: shadow.activationProbability ?? 0.3,
    trigger: shadow.trigger ?? ["heartbeat"],
    active_for_models: shadow.activeForModels ?? ["*"],
    ...(shadow.runWithModel ? { run_with_model: shadow.runWithModel } : {}),
    ...(shadow.thinkingLevel ? { thinking_level: shadow.thinkingLevel } : {}),
    ...(shadow.timeoutSeconds !== undefined
      ? { timeout_seconds: shadow.timeoutSeconds }
      : {}),
    ...(shadow.finalResponseRounds !== undefined
      ? { final_response_rounds: shadow.finalResponseRounds }
      : {}),
    ...(shadow.activationTools && shadow.activationTools.length
      ? { activation_tools: shadow.activationTools }
      : {}),
    tools: shadow.tools ?? [],
  };
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${(shadow.prompt ?? "").trim()}\n`;
}

export function describeShadow(shadow: ShadowDefinition): string {
  const actTools = shadow.activationTools.length
    ? ` act_tools=${shadow.activationTools.join(",")}`
    : "";
  const finalRounds = shadow.finalResponseRounds
    ? ` final_rounds=${shadow.finalResponseRounds}`
    : "";
  return `${shadow.enabled ? "enabled" : "disabled"} ${shadow.id} (${shadow.name}) p=${shadow.activationProbability} trigger=${shadow.trigger.join(",")} models=${shadow.activeForModels.join(",")}${finalRounds}${actTools} tools=${shadow.tools.join(",") || "default"} file=${basename(shadow.filePath)}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
