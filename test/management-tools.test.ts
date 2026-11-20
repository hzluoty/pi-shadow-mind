import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function setupTools(options: { withHook?: boolean } = {}) {
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
  const onMutated = vi.fn(async () => {
    await configStore.reload();
    await registry.load();
  });
  registerManagementTools(
    pi,
    store,
    () => configStore.current,
    options.withHook ? { onMutated } : {},
  );
  return { dir, configStore, registry, store, tools, onMutated };
}

function makeCtx(
  confirmResult = true,
  models: Array<{ provider: string; id: string }> = [
    { provider: "openrouter", id: "vendor/fast-model" },
  ],
) {
  const confirm = vi.fn().mockResolvedValue(confirmResult);
  return {
    confirm,
    ctx: {
      hasUI: true,
      ui: { confirm },
      modelRegistry: {
        getAll: () => models,
        find: (provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("update_shadow_config", () => {
  const slashModel = { provider: "openrouter", id: "vendor/fast-model" };

  it("rejects unknown default_shadow_model before prompting or writing", async () => {
    const { tools } = await setupTools();
    const { ctx, confirm } = makeCtx(true, [slashModel]);
    await expect(
      tools.get("update_shadow_config")!.execute(
        "call-1",
        { default_shadow_model: "vendor/nonexistent" },
        undefined,
        undefined,
        ctx as any,
      ),
    ).rejects.toThrow(/unknown shadow model: vendor\/nonexistent/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("accepts both bare and provider-prefixed models that resolve in the registry", async () => {
    const { configStore, tools } = await setupTools();
    const { ctx } = makeCtx(true, [slashModel]);
    await tools.get("update_shadow_config")!.execute(
      "call-2",
      { default_shadow_model: slashModel.id },
      undefined,
      undefined,
      ctx as any,
    );
    await configStore.reload();
    expect(configStore.current.defaultShadowModel).toBe(slashModel.id);

    await tools.get("update_shadow_config")!.execute(
      "call-3",
      { default_shadow_model: `${slashModel.provider}/${slashModel.id}` },
      undefined,
      undefined,
      ctx as any,
    );
    await configStore.reload();
    expect(configStore.current.defaultShadowModel).toBe(`${slashModel.provider}/${slashModel.id}`);
  });

  it("reads fresh disk config across consecutive calls and preserves manual disk edits", async () => {
    const { configStore, tools } = await setupTools();
    const { ctx } = makeCtx(true);
    const updateConfig = tools.get("update_shadow_config")!;

    await updateConfig.execute("c1", { max_parallel_shadows: 4 }, undefined, undefined, ctx as any);
    // In-memory configStore.current was NOT reloaded yet; second call must still keep max_parallel_shadows=4.
    await updateConfig.execute("c2", { heartbeat_probability: 0.5 }, undefined, undefined, ctx as any);

    // Simulate user hand-editing config.json on disk, then agent updating another key.
    const onDisk = JSON.parse(await readFile(configStore.configPath, "utf8"));
    onDisk.result_batch_window_ms = 900;
    await writeFile(configStore.configPath, JSON.stringify(onDisk, null, 2), "utf8");

    await updateConfig.execute("c3", { default_thinking_level: "medium" }, undefined, undefined, ctx as any);

    await configStore.reload();
    expect(configStore.current).toMatchObject({
      maxParallelShadows: 4,
      heartbeatProbability: 0.5,
      resultBatchWindowMs: 900,
      defaultThinkingLevel: "medium",
    });
  });

  it("allows updating unrelated fields even when stored default_shadow_model is offline", async () => {
    const { configStore, tools } = await setupTools();
    const onDisk = JSON.parse(await readFile(configStore.configPath, "utf8"));
    onDisk.default_shadow_model = "offline-provider/retired-model";
    await writeFile(configStore.configPath, JSON.stringify(onDisk, null, 2), "utf8");

    const { ctx } = makeCtx(true, [slashModel]);
    await tools.get("update_shadow_config")!.execute(
      "c1",
      { max_parallel_shadows: 3 },
      undefined,
      undefined,
      ctx as any,
    );
    await configStore.reload();
    expect(configStore.current.maxParallelShadows).toBe(3);
    expect(configStore.current.defaultShadowModel).toBe("offline-provider/retired-model");
  });

  it("refuses to overwrite a malformed config.json with stale in-memory defaults", async () => {
    const { configStore, tools } = await setupTools();
    await writeFile(configStore.configPath, "{ invalid json", "utf8");
    const { ctx, confirm } = makeCtx(true);
    await expect(
      tools.get("update_shadow_config")!.execute(
        "c1",
        { max_parallel_shadows: 3 },
        undefined,
        undefined,
        ctx as any,
      ),
    ).rejects.toThrow(/cannot read current config/);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("Shadow definition CRUD tools and EntityStore", () => {
  it("validates create_shadow before prompting and shows tools and prompt in confirmation", async () => {
    const { tools, onMutated } = await setupTools({ withHook: true });
    const create = tools.get("create_shadow")!;
    const list = tools.get("list_shadows")!;

    expect(textOf(await list.execute("l0", {}, undefined, undefined, {} as any))).toBe(
      "No Shadow Minds configured.",
    );

    const { ctx: badCtx, confirm: badConfirm } = makeCtx(true);
    await expect(
      create.execute("c0", { id: "bad", prompt: "   " }, undefined, undefined, badCtx as any),
    ).rejects.toThrow(/empty/);
    expect(badConfirm).not.toHaveBeenCalled();

    const { ctx: cancelCtx, confirm: cancelConfirm } = makeCtx(false);
    const cancelled = await create.execute(
      "c1",
      { id: "auditor", tools: ["*", "bash"], trigger: ["final_response"], prompt: "Audit everything." },
      undefined,
      undefined,
      cancelCtx as any,
    );
    expect(textOf(cancelled)).toBe("Cancelled.");
    expect(cancelConfirm).toHaveBeenCalledOnce();
    const confirmBody = cancelConfirm.mock.calls[0][1] as string;
    expect(confirmBody).toContain("tools: *, bash");
    expect(confirmBody).toContain("trigger: final_response");
    expect(confirmBody).toContain("Audit everything.");
    expect(textOf(await list.execute("l1", {}, undefined, undefined, {} as any))).toBe(
      "No Shadow Minds configured.",
    );

    const { ctx: okCtx } = makeCtx(true);
    const created = await create.execute(
      "c2",
      { id: "auditor", name: "Auditor", tools: ["bash"], prompt: "Audit everything." },
      undefined,
      undefined,
      okCtx as any,
    );
    expect(textOf(created)).toContain("Created enabled auditor (Auditor)");
    expect(onMutated).toHaveBeenCalledOnce();
    expect(textOf(await list.execute("l2", {}, undefined, undefined, {} as any))).toContain("auditor");
  });

  it("shows field and prompt diffs on update_shadow, toggles state, and keeps debug logs on delete", async () => {
    const { dir, tools, store, onMutated } = await setupTools({ withHook: true });
    await store.create({ id: "watcher", name: "Watcher", prompt: "Old prompt." });

    const update = tools.get("update_shadow")!;
    const enable = tools.get("enable_shadow")!;
    const disable = tools.get("disable_shadow")!;
    const del = tools.get("delete_shadow")!;

    const { ctx: missingCtx, confirm: missingConfirm } = makeCtx(true);
    await expect(
      update.execute("u0", { id: "missing", prompt: "New" }, undefined, undefined, missingCtx as any),
    ).rejects.toThrow(/shadow not found: missing/);
    await expect(
      disable.execute("d0", { id: "missing" }, undefined, undefined, missingCtx as any),
    ).rejects.toThrow(/shadow not found: missing/);
    await expect(
      del.execute("x0", { id: "missing" }, undefined, undefined, missingCtx as any),
    ).rejects.toThrow(/shadow not found: missing/);
    expect(missingConfirm).not.toHaveBeenCalled();

    const { ctx: updCtx, confirm: updConfirm } = makeCtx(true);
    await update.execute(
      "u1",
      { id: "watcher", tools: ["write"], prompt: "New prompt." },
      undefined,
      undefined,
      updCtx as any,
    );
    const diffMsg = updConfirm.mock.calls[0][1] as string;
    expect(diffMsg).toContain('tools: [] -> ["write"]');
    expect(diffMsg).toContain("--- before ---\nOld prompt.\n--- after ---\nNew prompt.");
    expect((await store.get("watcher")).tools).toEqual(["write"]);

    await disable.execute("d1", { id: "watcher" }, undefined, undefined, updCtx as any);
    expect((await store.get("watcher")).enabled).toBe(false);
    await enable.execute("e1", { id: "watcher" }, undefined, undefined, updCtx as any);
    expect((await store.get("watcher")).enabled).toBe(true);

    const logDir = join(dir, "shadow-minds", "logs", "watcher");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "run.jsonl"), "{}", "utf8");

    const delRes = await del.execute("x1", { id: "watcher" }, undefined, undefined, updCtx as any);
    expect(textOf(delRes)).toContain("logs were retained");
    expect(existsSync(logDir)).toBe(true);
    await expect(store.get("watcher")).rejects.toThrow(/shadow not found/);
    expect(onMutated).toHaveBeenCalledTimes(4);
  });

  it("prevents path traversal ids in EntityStore.previewCreate", async () => {
    const { store } = await setupTools();
    await expect(store.create({ id: "../escape", prompt: "bad" })).rejects.toThrow(/id must match/);
  });
});
