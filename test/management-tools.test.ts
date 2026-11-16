import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { EntityStore } from "../src/entity-store.js";
import { registerManagementTools } from "../src/management-tools.js";
import { ShadowRegistry } from "../src/registry.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setupConfigTool() {
  const dir = await mkdtemp(join(tmpdir(), "shadow-mgmt-"));
  dirs.push(dir);
  const configStore = new ConfigStore(dir);
  await configStore.initialize();
  const registry = new ShadowRegistry(dir);
  await registry.initialize();
  const store = new EntityStore(registry, configStore.configPath);
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  registerManagementTools(pi, store, () => configStore.current);
  return { configStore, updateTool: tools.get("update_shadow_config")! };
}

describe("update_shadow_config model validation", () => {
  const glm = { provider: "magpie", id: "autoclaw-cn/zai_glm-5.3-flash" };
  const ctxBase = {
    hasUI: true,
    ui: { confirm: vi.fn().mockResolvedValue(true) },
    modelRegistry: {
      getAll: () => [glm],
      find: (provider: string, id: string) =>
        provider === glm.provider && id === glm.id ? glm : undefined,
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
    },
  };

  it("rejects unknown default_shadow_model before prompting or writing", async () => {
    const { updateTool } = await setupConfigTool();
    ctxBase.ui.confirm.mockClear();
    await expect(
      updateTool.execute(
        "call-1",
        { default_shadow_model: "autoclaw-cn/nonexistent" },
        undefined,
        undefined,
        ctxBase as any,
      ),
    ).rejects.toThrow(/unknown shadow model: autoclaw-cn\/nonexistent/);
    expect(ctxBase.ui.confirm).not.toHaveBeenCalled();
  });

  it("accepts both bare and provider-prefixed models that resolve in the registry", async () => {
    const { configStore, updateTool } = await setupConfigTool();
    await updateTool.execute(
      "call-2",
      { default_shadow_model: glm.id },
      undefined,
      undefined,
      ctxBase as any,
    );
    await configStore.reload();
    expect(configStore.current.defaultShadowModel).toBe(glm.id);

    await updateTool.execute(
      "call-3",
      { default_shadow_model: `${glm.provider}/${glm.id}` },
      undefined,
      undefined,
      ctxBase as any,
    );
    await configStore.reload();
    expect(configStore.current.defaultShadowModel).toBe(`${glm.provider}/${glm.id}`);
  });
});
