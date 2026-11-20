import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseShadowMarkdown, ShadowRegistry } from "../src/registry.js";

describe("parseShadowMarkdown", () => {
  it("applies shadow defaults", () => {
    const shadow = parseShadowMarkdown(
      "---\nname: Fact checker\n---\nCheck claims against the project.",
      "C:/tmp/facts.md",
    );
    expect(shadow).toMatchObject({
      id: "facts",
      name: "Fact checker",
      enabled: true,
      debug: false,
      activationProbability: 0.3,
      trigger: ["heartbeat"],
      activeForModels: ["*"],
      tools: [],
      activationTools: [],
    });
  });

  it("parses activation_tools", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: write-checker\nactivation_tools: [bash, edit, write]\n---\nReview changes.",
      "C:/tmp/write-checker.md",
    );
    expect(shadow.activationTools).toEqual(["bash", "edit", "write"]);
  });

  it("parses final_response_rounds and defaults to unlimited", () => {
    const unlimited = parseShadowMarkdown(
      "---\nid: unlimited\ntrigger: final_response\n---\nReview completion.",
      "C:/tmp/unlimited.md",
    );
    const limited = parseShadowMarkdown(
      "---\nid: limited\ntrigger: final_response\nfinal_response_rounds: 1\n---\nReview completion.",
      "C:/tmp/limited.md",
    );
    const explicitUnlimited = parseShadowMarkdown(
      "---\nid: explicit-unlimited\nfinal_response_rounds: 0\n---\nReview completion.",
      "C:/tmp/explicit-unlimited.md",
    );
    expect(unlimited.finalResponseRounds).toBeUndefined();
    expect(limited.finalResponseRounds).toBe(1);
    expect(explicitUnlimited.finalResponseRounds).toBe(0);
  });

  it("rejects invalid final_response_rounds", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad\nfinal_response_rounds: -1\n---\nReview.",
        "C:/tmp/bad-rounds.md",
      ),
    ).toThrow(/final_response_rounds/);
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad\nfinal_response_rounds: 1.5\n---\nReview.",
        "C:/tmp/bad-rounds.md",
      ),
    ).toThrow(/final_response_rounds/);
  });

  it("rejects invalid activation_tools", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad-tools\nactivation_tools: [123]\n---\nReview.",
        "C:/tmp/bad.md",
      ),
    ).toThrow(/activation_tools/);
  });

  it("accepts one or multiple activation triggers", () => {
    const single = parseShadowMarkdown(
      "---\nid: final-check\ntrigger: final_response\n---\nReview completion.",
      "C:/tmp/final.md",
    );
    const multiple = parseShadowMarkdown(
      "---\nid: both\ntrigger: [heartbeat, final_response]\n---\nReview progress.",
      "C:/tmp/both.md",
    );
    expect(single.trigger).toEqual(["final_response"]);
    expect(multiple.trigger).toEqual(["heartbeat", "final_response"]);
  });

  it("rejects unknown activation triggers", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: invalid\ntrigger: manual\n---\nReview.",
        "C:/tmp/invalid.md",
      ),
    ).toThrow(/invalid trigger/);
  });

  it("rejects an empty prompt", () => {
    expect(() =>
      parseShadowMarkdown("---\nid: empty\n---\n", "C:/tmp/empty.md"),
    ).toThrow(/empty/);
  });

  it("accepts off as a thinking level", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: quick-check\nthinking_level: off\n---\nCheck once and report.",
      "C:/tmp/quick-check.md",
    );
    expect(shadow.thinkingLevel).toBe("off");
  });
});

describe("ShadowRegistry.load", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function makeRegistry() {
    const dir = await mkdtemp(join(tmpdir(), "shadow-reg-"));
    dirs.push(dir);
    const registry = new ShadowRegistry(dir);
    await registry.initialize();
    return { dir, registry };
  }

  it("loads definitions, reloads when size/ctime changes under identical mtime, and removes deleted entries", async () => {
    const { registry } = await makeRegistry();
    const aPath = join(registry.directory, "a.md");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");

    await writeFile(aPath, "---\nid: alpha\n---\nPrompt v1.", "utf8");
    await utimes(aPath, fixedTime, fixedTime);
    const first = await registry.load();
    expect(first.shadows.map((s) => s.prompt)).toEqual(["Prompt v1."]);

    // Rewrite with same mtime (different length + ctime) — must not serve stale cache.
    await writeFile(aPath, "---\nid: alpha\n---\nPrompt v2 updated!", "utf8");
    await utimes(aPath, fixedTime, fixedTime);
    const second = await registry.load();
    expect(second.shadows.map((s) => s.prompt)).toEqual(["Prompt v2 updated!"]);

    await unlink(aPath);
    const third = await registry.load();
    expect(third.shadows).toEqual([]);
  });

  it("isolates invalid markdown, duplicate ids, non-regular entries, and broken symlinks", async () => {
    const { dir, registry } = await makeRegistry();
    await writeFile(join(registry.directory, "01-good.md"), "---\nid: good\n---\nCheck facts.", "utf8");
    await writeFile(join(registry.directory, "02-dup.md"), "---\nid: good\n---\nDuplicate id.", "utf8");
    await writeFile(join(registry.directory, "03-bad.md"), "no frontmatter", "utf8");
    await mkdir(join(registry.directory, "04-dir.md"));
    try {
      await symlink(join(dir, "nonexistent-target.md"), join(registry.directory, "05-broken.md"));
    } catch {
      // Skip symlink test case if OS/filesystem denies symlinks.
    }

    const snap = await registry.load();
    expect(snap.shadows.map((s) => s.id)).toEqual(["good"]);
    expect(snap.shadows[0].prompt).toBe("Check facts.");
    expect(snap.diagnostics.some((d) => d.message.includes("duplicate shadow id: good"))).toBe(true);
    expect(snap.diagnostics.some((d) => d.message.includes("missing YAML frontmatter"))).toBe(true);
    expect(snap.diagnostics.some((d) => d.message.includes("not a regular file"))).toBe(true);
  });
});
