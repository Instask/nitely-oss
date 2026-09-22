import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { resolveLocalFileResource } from "../../src/connectors/local-file.js";
import { loadContextPolicy } from "../../src/context/policy.js";
import { EventStore } from "../../src/events/store.js";
import {
  evalManifestSha256,
  parseEvalCohortManifest,
  type EvalCohortManifest,
} from "../../src/eval/manifest.js";
import { executeEvalReplay, planEvalReplay } from "../../src/eval/replay.js";
import { eventStorePath } from "../../src/run/project.js";
import { sha256Text } from "../../src/run/reproducibility.js";

const execFileAsync = promisify(execFile);

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface ReplayFixture {
  repoPath: string;
  revision: string;
  manifest: EvalCohortManifest;
  flowDocument: string;
  inputDocument: string;
  policySha256: string;
}

async function createReplayFixture(): Promise<ReplayFixture> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-replay-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "eval@example.test"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Eval Test"], { cwd: repoPath });

  const flowDocument = `${JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: {
      name: "eval-case",
      inputs: [{ id: "ticket" }],
      configurables: [
        { key: "reviewMode", type: "text", label: "Review mode", required: true },
        { key: "dryRun", type: "boolean", label: "Dry run", default: true },
      ],
    },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "codex",
          model: "gpt-5.1-codex",
          prompt: "Implement the ticket.",
          inputs: ["ticket"],
          outputs: ["implementation"],
        },
        {
          id: "review",
          type: "gate",
          mode: "review",
          runtime: "codex",
          model: "gpt-5.1-codex",
          prompt: "Review the implementation.",
          inputs: ["ticket", "implementation"],
          outputs: ["review"],
        },
      ],
    },
  }, null, 2)}\n`;
  const inputDocument = "Upgrade Zod without changing public behavior.\n";
  const policyDocument = `${JSON.stringify({
    version: 1,
    include: ["**/*"],
    exclude: [],
    warnOnly: false,
    redactEnv: [],
  })}\n`;

  await mkdir(join(repoPath, "flows"), { recursive: true });
  await mkdir(join(repoPath, "fixtures"), { recursive: true });
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(join(repoPath, "flows/eval.json"), flowDocument, "utf8");
  await writeFile(join(repoPath, "fixtures/ticket.md"), inputDocument, "utf8");
  await writeFile(join(repoPath, "nitely.context.json"), policyDocument, "utf8");
  await writeFile(join(repoPath, "README.md"), "# Eval fixture\n", "utf8");
  await writeFile(join(repoPath, ".gitignore"), ".nitely/\n", "utf8");
  await execFileAsync(
    "git",
    ["add", ".gitignore", "README.md", "flows", "fixtures", "nitely.context.json"],
    { cwd: repoPath },
  );
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repoPath });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  const revision = stdout.trim();
  const policySha256 = sha256Text(JSON.stringify(await loadContextPolicy(repoPath)));

  const manifest = parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: { id: "candidate", baselineCohortId: "baseline" },
    cases: [
      {
        id: "upgrade-zod",
        baselineRunId: "run-baseline",
        source: { revision },
        flow: { path: "flows/eval.json", sha256: digest(flowDocument) },
        inputs: [
          {
            id: "ticket",
            path: "fixtures/ticket.md",
            sha256: digest(inputDocument),
          },
        ],
        runtime: {
          executionBackend: "local",
          sandboxPolicy: { codex: "danger-full-access" },
          stages: [
            { stageId: "implement", runtime: "codex", model: "gpt-5.1-codex" },
            { stageId: "review", runtime: "codex", model: "gpt-5.1-codex" },
          ],
        },
        configuration: { reviewMode: "strict" },
        contextPolicy: { sha256: policySha256 },
        expectedGates: ["review"],
        allowedNondeterminism: [
          { id: "model-output", description: "Equivalent implementation prose may differ." },
        ],
        scoring: { requireReviewablePr: true, requireExpectedGates: true },
      },
    ],
    thresholds: {},
  });

  const runDirectory = join(repoPath, ".nitely/runs/run-baseline");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "reproducibility.json"),
    `${JSON.stringify({
      version: 1,
      runId: "run-baseline",
      generatedAt: "2026-07-15T00:00:00.000Z",
      replayability: "partially-replayable",
      repo: { path: repoPath, baseCommit: revision, headCommit: revision },
      flow: {
        name: "eval-case",
        path: "flows/eval.json",
        documentSha256: digest(flowDocument),
        configurationSha256: sha256Text(JSON.stringify({
          reviewMode: "strict",
          dryRun: true,
        })),
      },
      inputs: [
        {
          id: "ticket",
          connector: "local-file",
          sourceUri: "fixtures/ticket.md",
          sha256: digest(inputDocument),
        },
      ],
      context: {
        policySha256,
        constitution: { loaded: false, path: ".nitely/constitution.md" },
        projectInstructions: {
          loaded: false,
          path: ".nitely/instructions.json",
        },
      },
      runtimes: [
        {
          stageId: "implement",
          kind: "agent",
          candidates: [{ runtime: "codex", model: "gpt-5.1-codex" }],
          selected: { runtime: "codex", model: "gpt-5.1-codex" },
        },
        {
          stageId: "review",
          kind: "review-gate",
          candidates: [{ runtime: "codex", model: "gpt-5.1-codex" }],
          selected: { runtime: "codex", model: "gpt-5.1-codex" },
        },
      ],
      commands: [],
      skills: [],
      providers: [],
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        executionBackend: "local",
        sandboxPolicy: { codex: "danger-full-access" },
      },
      nonDeterministicFactors: [
        "agent runtime output depends on external model/provider behavior",
      ],
      missingReplayPrerequisites: [],
    }, null, 2)}\n`,
    "utf8",
  );

  return { repoPath, revision, manifest, flowDocument, inputDocument, policySha256 };
}

describe("eval replay planning", () => {
  it("builds an ordinary run input only after every pinned reference is compatible", async () => {
    const fixture = await createReplayFixture();

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("ready");
    expect(plan.findings).toEqual([]);
    expect(plan.runInput).toEqual({
      repoPath: fixture.repoPath,
      flowPath: join(fixture.repoPath, "flows/eval.json"),
      flowDocument: fixture.flowDocument,
      expectedSourceRevision: fixture.revision,
      expectedContextPolicySha256: fixture.policySha256,
      expectedPromptContext: {
        constitution: { loaded: false, path: ".nitely/constitution.md" },
        projectInstructions: {
          loaded: false,
          path: ".nitely/instructions.json",
        },
      },
      expectedSkillContentHashes: {},
      executionBackend: "local",
      sandboxPolicy: { codex: "danger-full-access" },
      configuration: { reviewMode: "strict", dryRun: true },
      inputs: {
        ticket: {
          connector: "local-file",
          uri: "fixtures/ticket.md",
          options: { expectedSha256: digest(fixture.inputDocument) },
        },
      },
    });
    await expect(
      resolveLocalFileResource(
        fixture.repoPath,
        plan.status === "ready" ? plan.runInput.inputs.ticket : { connector: "", uri: "" },
      ),
    ).resolves.toMatchObject({
      repoRelativePath: "fixtures/ticket.md",
    });
  });

  it("rejects an oversized pinned input during replay planning", async () => {
    const fixture = await createReplayFixture();
    const oversizedInput = "x".repeat(16 * 1024 * 1024 + 1);
    await writeFile(
      join(fixture.repoPath, "fixtures/ticket.md"),
      oversizedInput,
      "utf8",
    );
    await execFileAsync("git", ["add", "fixtures/ticket.md"], {
      cwd: fixture.repoPath,
    });
    await execFileAsync("git", ["commit", "-m", "oversized pinned input"], {
      cwd: fixture.repoPath,
    });
    const revision = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.repoPath,
      })
    ).stdout.trim();
    const inputSha256 = digest(oversizedInput);
    fixture.manifest.cases[0].source.revision = revision;
    fixture.manifest.cases[0].inputs[0].sha256 = inputSha256;
    const baselinePath = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.repo.baseCommit = revision;
    baseline.repo.headCommit = revision;
    baseline.inputs[0].sha256 = inputSha256;
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "pinned_content_too_large" }),
    ]));
  });

  it("uses the baseline input commit even when the ordinary run produced a new head", async () => {
    const fixture = await createReplayFixture();
    const path = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(path, "utf8"));
    baseline.repo.headCommit = "f".repeat(40);
    await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("ready");
    expect(plan.findings).toEqual([]);
  });

  it("rejects a well-formed manifest digest that does not describe the supplied manifest", async () => {
    const fixture = await createReplayFixture();

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: `sha256:${"f".repeat(64)}`,
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.runInput).toBeUndefined();
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "manifest_digest_mismatch" }),
    ]));
  });

  it("treats schema-valid uppercase digests and revisions as canonical identities", async () => {
    const fixture = await createReplayFixture();
    const evalCase = fixture.manifest.cases[0];
    evalCase.source.revision = evalCase.source.revision.toUpperCase();
    evalCase.flow.sha256 = evalCase.flow.sha256.toUpperCase();
    evalCase.inputs[0].sha256 = evalCase.inputs[0].sha256.toUpperCase();
    evalCase.contextPolicy.sha256 = evalCase.contextPolicy.sha256.toUpperCase();
    const baselinePath = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.repo.baseCommit = baseline.repo.baseCommit.toUpperCase();
    baseline.repo.headCommit = baseline.repo.headCommit.toUpperCase();
    baseline.flow.documentSha256 = baseline.flow.documentSha256.toUpperCase();
    baseline.inputs[0].sha256 = baseline.inputs[0].sha256.toUpperCase();
    baseline.context.policySha256 = baseline.context.policySha256.toUpperCase();
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");
    const canonicalManifestSha256 = evalManifestSha256(fixture.manifest);

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: canonicalManifestSha256.toUpperCase(),
      caseId: "upgrade-zod",
    });

    const findingCodes = plan.findings.map((finding) => finding.code);
    for (const code of [
      "manifest_digest_mismatch",
      "source_revision_mismatch",
      "content_digest_mismatch",
      "context_policy_mismatch",
      "baseline_source_mismatch",
      "baseline_flow_mismatch",
      "baseline_input_mismatch",
    ]) {
      expect(findingCodes).not.toContain(code);
    }
    expect(plan.manifestSha256).toBe(canonicalManifestSha256);
    if (process.platform === "linux") {
      expect(plan.status).toBe("ready");
      expect(plan.status === "ready" && plan.runInput.expectedContextPolicySha256)
        .toBe(fixture.policySha256);
    }
  });

  it("rejects unknown Flow configuration before constructing a run input", async () => {
    const fixture = await createReplayFixture();
    fixture.manifest.cases[0].configuration = {
      reviewMode: "strict",
      undeclaredMode: "must-not-reach-runFlow",
    };

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.runInput).toBeUndefined();
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "configuration_invalid",
        message: "unknown configurable: undeclaredMode",
      }),
    ]));
  });

  it("rejects an unsupported execution backend before invoking the runner", async () => {
    const fixture = await createReplayFixture();
    fixture.manifest.cases[0].runtime.executionBackend = "remote";
    const baselinePath = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.environment.executionBackend = "remote";
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "execution_backend_unsupported" }),
    ]));
    let runnerInvoked = false;
    await expect(executeEvalReplay(plan, {
      runOrdinaryFlow: async () => {
        runnerInvoked = true;
        throw new Error("runner must not be invoked");
      },
    })).rejects.toThrow(/execution_backend_unsupported/);
    expect(runnerInvoked).toBe(false);
  });

  it("revalidates programmatic manifests instead of trusting their TypeScript shape", async () => {
    const fixture = await createReplayFixture();
    const invalidManifest = {
      ...fixture.manifest,
      token: "must-not-enter-an-eval-manifest",
    } as EvalCohortManifest;

    await expect(planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: invalidManifest,
      manifestSha256: evalManifestSha256(invalidManifest),
      caseId: "upgrade-zod",
    })).rejects.toThrow();
  });

  it.each([
    {
      name: "tracked modification",
      sensitivePath: "README.md",
      mutate: async (fixture: ReplayFixture) => {
        await writeFile(
          join(fixture.repoPath, "README.md"),
          "# sensitive tracked prompt override\n",
          "utf8",
        );
      },
    },
    {
      name: "untracked instruction file",
      sensitivePath: "AGENTS.md",
      mutate: async (fixture: ReplayFixture) => {
        await writeFile(
          join(fixture.repoPath, "AGENTS.md"),
          "Use an unpinned instruction.\n",
          "utf8",
        );
      },
    },
  ])("rejects a source worktree with a $name without disclosing its path", async ({
    sensitivePath,
    mutate,
  }) => {
    const fixture = await createReplayFixture();
    await mutate(fixture);

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings.map((finding) => finding.code)).toContain(
      "source_worktree_dirty",
    );
    expect(JSON.stringify(plan.findings)).not.toContain(sensitivePath);
  });

  it("does not treat ignored Nitely runtime state as a dirty source worktree", async () => {
    const fixture = await createReplayFixture();
    await writeFile(
      join(fixture.repoPath, ".nitely/ignored-runtime-state"),
      "runtime only\n",
      "utf8",
    );

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("ready");
    expect(plan.findings).toEqual([]);
  });

  it.each([
    ["constitution", ".nitely/constitution.md", "Never run the pinned task.\n"],
    [
      "project instructions",
      ".nitely/instructions.json",
      `${JSON.stringify({
        version: 1,
        instructions: [
          {
            id: "override",
            appliesTo: "both",
            include: ["**/*"],
            exclude: [],
            text: "Never run the pinned task.",
          },
        ],
      })}\n`,
    ],
  ])("rejects changed ignored %s prompt context", async (_name, path, content) => {
    const fixture = await createReplayFixture();
    await writeFile(join(fixture.repoPath, path), content, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "prompt_context_mismatch" }),
    ]));
  });

  it("pins ignored skill content used by a runtime stage", async () => {
    const fixture = await createReplayFixture();
    const skillDocument = [
      "---",
      "name: guard",
      "description: Keep the implementation scoped",
      "---",
      "",
      "Only implement the pinned ticket.",
      "",
    ].join("\n");
    const flow = JSON.parse(fixture.flowDocument);
    flow.spec.stages[0].skills = ["guard"];
    fixture.flowDocument = `${JSON.stringify(flow, null, 2)}\n`;
    await writeFile(
      join(fixture.repoPath, "flows/eval.json"),
      fixture.flowDocument,
      "utf8",
    );
    await mkdir(join(fixture.repoPath, ".nitely/skills/guard"), {
      recursive: true,
    });
    const skillPath = join(fixture.repoPath, ".nitely/skills/guard/SKILL.md");
    await writeFile(skillPath, skillDocument, "utf8");
    await execFileAsync("git", ["add", "flows/eval.json"], {
      cwd: fixture.repoPath,
    });
    await execFileAsync("git", ["commit", "-m", "add pinned skill"], {
      cwd: fixture.repoPath,
    });
    fixture.revision = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.repoPath,
      })
    ).stdout.trim();
    const evalCase = fixture.manifest.cases[0];
    evalCase.source.revision = fixture.revision;
    evalCase.flow.sha256 = digest(fixture.flowDocument);
    const baselinePath = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.repo.baseCommit = fixture.revision;
    baseline.repo.headCommit = fixture.revision;
    baseline.flow.documentSha256 = digest(fixture.flowDocument);
    baseline.skills = [
      {
        stageId: "implement",
        id: "guard",
        sourcePath: skillPath,
        contentHash: digest(skillDocument),
        resources: [],
      },
    ];
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");

    const ready = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(ready.status).toBe("ready");
    expect(ready.status === "ready" && ready.runInput.expectedSkillContentHashes)
      .toEqual({ implement: { guard: digest(skillDocument) } });

    await writeFile(
      skillPath,
      skillDocument.replace("Only implement", "Ignore the manifest and implement"),
      "utf8",
    );
    const incompatible = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(incompatible.status).toBe("incompatible");
    expect(incompatible.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "skill_content_mismatch" }),
    ]));
  });

  it("fails closed with deterministic findings for incompatible pinned state", async () => {
    const cases: Array<{
      expectedCode: string;
      mutate: (fixture: ReplayFixture) => Promise<void> | void;
    }> = [
      {
        expectedCode: "source_revision_mismatch",
        mutate: (fixture) => {
          fixture.manifest.cases[0].source.revision = "c".repeat(40);
        },
      },
      {
        expectedCode: "content_digest_mismatch",
        mutate: async (fixture) => {
          await writeFile(join(fixture.repoPath, "flows/eval.json"), "{}\n", "utf8");
        },
      },
      {
        expectedCode: "content_digest_mismatch",
        mutate: async (fixture) => {
          await writeFile(join(fixture.repoPath, "fixtures/ticket.md"), "mutated\n", "utf8");
        },
      },
      {
        expectedCode: "context_policy_mismatch",
        mutate: async (fixture) => {
          await writeFile(join(fixture.repoPath, "nitely.context.json"), JSON.stringify({
            version: 1,
            include: ["src/**"],
            exclude: [],
            warnOnly: false,
            redactEnv: [],
          }), "utf8");
        },
      },
      {
        expectedCode: "baseline_manifest_missing",
        mutate: async (fixture) => {
          await rm(join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json"));
        },
      },
      {
        expectedCode: "baseline_manifest_invalid",
        mutate: async (fixture) => {
          await writeFile(
            join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json"),
            "{}\n",
            "utf8",
          );
        },
      },
      {
        expectedCode: "baseline_not_replayable",
        mutate: async (fixture) => {
          const path = join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json");
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.replayability = "diagnostic-only";
          baseline.missingReplayPrerequisites = ["missing source snapshot"];
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
      {
        expectedCode: "runtime_selection_mismatch",
        mutate: (fixture) => {
          fixture.manifest.cases[0].runtime.stages[0].model = "different-model";
        },
      },
      {
        expectedCode: "sandbox_policy_mismatch",
        mutate: async (fixture) => {
          const path = join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json");
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.environment.sandboxPolicy.codex = "read-only";
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
      {
        expectedCode: "baseline_configuration_mismatch",
        mutate: async (fixture) => {
          const path = join(
            fixture.repoPath,
            ".nitely/runs/run-baseline/reproducibility.json",
          );
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.flow.configurationSha256 = sha256Text(
            JSON.stringify({ reviewMode: "permissive", dryRun: true }),
          );
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
      {
        expectedCode: "runtime_selection_mismatch",
        mutate: async (fixture) => {
          const extra = { stageId: "ghost", runtime: "codex", model: "gpt-5.1-codex" };
          fixture.manifest.cases[0].runtime.stages.push(extra);
          const path = join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json");
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.runtimes.push({
            stageId: "ghost",
            kind: "agent",
            candidates: [{ runtime: extra.runtime, model: extra.model }],
            selected: { runtime: extra.runtime, model: extra.model },
          });
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
      {
        expectedCode: "runtime_selection_mismatch",
        mutate: async (fixture) => {
          const path = join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json");
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.runtimes.push({
            stageId: "baseline-only",
            kind: "agent",
            candidates: [{ runtime: "codex" }],
            selected: { runtime: "codex" },
          });
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
      {
        expectedCode: "baseline_input_mismatch",
        mutate: async (fixture) => {
          const path = join(fixture.repoPath, ".nitely/runs/run-baseline/reproducibility.json");
          const baseline = JSON.parse(await readFile(path, "utf8"));
          baseline.inputs.push({
            id: "baseline-only",
            connector: "local-file",
            sourceUri: "fixtures/other.md",
            sha256: digest("other"),
          });
          await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");
        },
      },
    ];

    for (const scenario of cases) {
      const fixture = await createReplayFixture();
      await scenario.mutate(fixture);

      const plan = await planEvalReplay({
        repoPath: fixture.repoPath,
        manifest: fixture.manifest,
        manifestSha256: evalManifestSha256(fixture.manifest),
        caseId: "upgrade-zod",
      });

      expect(plan.status).toBe("incompatible");
      expect(plan.runInput).toBeUndefined();
      expect(plan.findings.map((finding) => finding.code)).toContain(scenario.expectedCode);
    }
  });

  it("accepts only baseline nondeterminism explicitly declared by the eval case", async () => {
    const fixture = await createReplayFixture();
    fixture.manifest.cases[0].allowedNondeterminism = [];

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "baseline_nondeterminism_undeclared",
        actual: "agent runtime output depends on external model/provider behavior",
      }),
    ]));
  });

  it("rejects an extra baseline nondeterministic factor that was not declared", async () => {
    const fixture = await createReplayFixture();
    const path = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(path, "utf8"));
    baseline.nonDeterministicFactors.push("unrecognized mutable runtime state");
    await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "baseline_nondeterminism_undeclared",
        actual: "unrecognized mutable runtime state",
      }),
    ]));
  });

  it.each([
    {
      name: "missing version",
      mutate: (baseline: Record<string, any>) => {
        delete baseline.version;
      },
    },
    {
      name: "malformed nested runtime selection",
      mutate: (baseline: Record<string, any>) => {
        baseline.runtimes[0].selected.model = 42;
      },
    },
    {
      name: "missing baseline input commit",
      mutate: (baseline: Record<string, any>) => {
        delete baseline.repo.baseCommit;
      },
    },
    {
      name: "malformed baseline input commit",
      mutate: (baseline: Record<string, any>) => {
        baseline.repo.baseCommit = "mutable-ref";
      },
    },
  ])("rejects a baseline runtime document with $name", async ({ mutate }) => {
    const fixture = await createReplayFixture();
    const path = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(path, "utf8"));
    mutate(baseline);
    await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings.map((finding) => finding.code)).toContain(
      "baseline_manifest_invalid",
    );
  });

  it.each([
    {
      name: "run id",
      mutate: (baseline: Record<string, any>) => {
        baseline.runId = "different-run";
      },
    },
    {
      name: "Flow path",
      mutate: (baseline: Record<string, any>) => {
        baseline.flow.path = "flows/different.json";
      },
    },
    {
      name: "input source",
      mutate: (baseline: Record<string, any>) => {
        baseline.inputs[0].sourceUri = "fixtures/different.md";
      },
    },
  ])("rejects baseline $name identity mismatch", async ({ mutate }) => {
    const fixture = await createReplayFixture();
    const path = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(path, "utf8"));
    mutate(baseline);
    await writeFile(path, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings.map((finding) => finding.code)).toContain(
      "baseline_manifest_identity_mismatch",
    );
  });

  it("rejects an oversized baseline reproducibility document before parsing", async () => {
    const fixture = await createReplayFixture();
    const path = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    await writeFile(path, " ".repeat(1024 * 1024 + 1), "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings.map((finding) => finding.code)).toContain(
      "baseline_manifest_invalid",
    );
  });

  it(
    "rejects a baseline reproducibility document reached through a symbolic link",
    async () => {
      const fixture = await createReplayFixture();
      const path = join(
        fixture.repoPath,
        ".nitely/runs/run-baseline/reproducibility.json",
      );
      const outsideDirectory = await mkdtemp(join(tmpdir(), "nitely-eval-baseline-"));
      const outsidePath = join(outsideDirectory, "reproducibility.json");
      await writeFile(outsidePath, await readFile(path));
      await rm(path);
      await symlink(outsidePath, path);

      const plan = await planEvalReplay({
        repoPath: fixture.repoPath,
        manifest: fixture.manifest,
        manifestSha256: evalManifestSha256(fixture.manifest),
        caseId: "upgrade-zod",
      });

      expect(plan.status).toBe("incompatible");
      expect(plan.findings.map((finding) => finding.code)).toContain(
        "baseline_manifest_unsafe",
      );
    },
  );

  it(
    "rejects a hard-linked baseline reproducibility document",
    async () => {
      const fixture = await createReplayFixture();
      const path = join(
        fixture.repoPath,
        ".nitely/runs/run-baseline/reproducibility.json",
      );
      const outsideDirectory = await mkdtemp(join(tmpdir(), "nitely-eval-baseline-"));
      const outsidePath = join(outsideDirectory, "reproducibility.json");
      await writeFile(outsidePath, await readFile(path));
      await rm(path);
      await link(outsidePath, path);

      const plan = await planEvalReplay({
        repoPath: fixture.repoPath,
        manifest: fixture.manifest,
        manifestSha256: evalManifestSha256(fixture.manifest),
        caseId: "upgrade-zod",
      });

      expect(plan.status).toBe("incompatible");
      expect(plan.findings.map((finding) => finding.code)).toContain(
        "baseline_manifest_unsafe",
      );
    },
  );

  it("redacts sensitive filesystem details from incompatibility findings", async () => {
    const fixture = await createReplayFixture();
    const secret = "provider-secret-value-123";
    fixture.manifest.cases[0].flow.path = `flows/api_key=${secret}.json`;

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(JSON.stringify(plan.findings)).not.toContain(secret);
    expect(JSON.stringify(plan.findings)).toContain("[REDACTED]");
  });

  it("rejects a pinned local input whose symlink escapes the repository", async () => {
    const fixture = await createReplayFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "nitely-eval-outside-"));
    const outsidePath = join(outsideDirectory, "ticket.md");
    const outsideDocument = "outside repository content\n";
    await writeFile(outsidePath, outsideDocument, "utf8");
    const inputPath = join(fixture.repoPath, "fixtures/ticket.md");
    await rm(inputPath);
    await symlink(outsidePath, inputPath);
    fixture.manifest.cases[0].inputs[0].sha256 = digest(outsideDocument);
    const baselinePath = join(
      fixture.repoPath,
      ".nitely/runs/run-baseline/reproducibility.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.inputs[0].sha256 = digest(outsideDocument);
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");

    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });

    expect(plan.status).toBe("incompatible");
    expect(plan.findings.map((finding) => finding.code)).toContain("pinned_path_escape");
  });

  it("executes a ready plan through the ordinary runner and links its ordinary event record", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");
    const runInputs: unknown[] = [];
    let invocationId = "";

    const executed = await executeEvalReplay(plan, {
      createRunId: () => "eval-run-1",
      runOrdinaryFlow: async (runInput, runId) => {
        runInputs.push(runInput);
        invocationId = runInput.evalReplayInvocationId ?? "";
        expect(invocationId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(runId).toBe("eval-run-1");
        const store = new EventStore(eventStorePath(fixture.repoPath));
        store.append({
          runId,
          type: "run.created",
          payload: { evalReplayInvocationId: invocationId },
        });
        store.append({ runId, type: "run.completed", payload: {} });
        store.close();
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(fixture.repoPath, ".nitely/runs", runId, "worktree"),
        };
      },
    });

    expect(executed.result.runId).toBe("eval-run-1");
    expect(runInputs).toEqual([
      plan.status === "ready"
        ? { ...plan.runInput, evalReplayInvocationId: invocationId }
        : undefined,
    ]);
    const store = new EventStore(eventStorePath(fixture.repoPath));
    const linked = store.list("eval-run-1").find((entry) => entry.type === "eval.replay.linked");
    store.close();
    expect(linked?.payload).toEqual({
      schemaVersion: "nitely.eval-replay-link.v1",
      cohortId: "candidate",
      caseId: "upgrade-zod",
      baselineCohortId: "baseline",
      baselineRunId: "run-baseline",
      manifestSha256: evalManifestSha256(fixture.manifest),
      sourceRevision: fixture.revision,
      allowedNondeterminism: ["model-output"],
      invocationId,
      outcome: "completed",
    });
  });

  it("rejects a chosen run id that already owns ordinary events before invoking the runner", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");
    const store = new EventStore(eventStorePath(fixture.repoPath));
    store.append({ runId: "eval-collision", type: "run.created", payload: {} });
    store.append({ runId: "eval-collision", type: "run.completed", payload: {} });
    store.close();
    let runnerCalls = 0;

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-collision",
      runOrdinaryFlow: async () => {
        runnerCalls += 1;
        throw new Error("runner must not be called for a colliding run id");
      },
    })).rejects.toThrow(/run id eval-collision already has events/i);

    expect(runnerCalls).toBe(0);
    const after = new EventStore(eventStorePath(fixture.repoPath));
    expect(after.list("eval-collision").map((event) => event.type)).toEqual([
      "run.created",
      "run.completed",
    ]);
    after.close();
  });

  it("fails closed when a successful ordinary runner returns without event evidence", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-no-evidence",
      runOrdinaryFlow: async (_runInput, runId) => ({
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(fixture.repoPath, ".nitely/runs", runId, "worktree"),
      }),
    })).rejects.toThrow(/returned without ordinary event evidence/i);
  });

  it("does not link colliding evidence created by another invocation", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-raced-collision",
      runOrdinaryFlow: async (_runInput, runId) => {
        const store = new EventStore(eventStorePath(fixture.repoPath));
        store.append({ runId, type: "run.created", payload: {} });
        store.append({ runId, type: "run.completed", payload: {} });
        store.close();
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(
            fixture.repoPath,
            ".nitely/runs",
            runId,
            "worktree",
          ),
        };
      },
    })).rejects.toThrow(/invocation evidence/i);

    const store = new EventStore(eventStorePath(fixture.repoPath));
    expect(store.list("eval-raced-collision").some(
      (event) => event.type === "eval.replay.linked",
    )).toBe(false);
    store.close();
  });

  it("links failed terminal ordinary evidence before preserving the operation error", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-failed-run",
      runOrdinaryFlow: async (runInput, runId) => {
        const store = new EventStore(eventStorePath(fixture.repoPath));
        store.append({
          runId,
          type: "run.created",
          payload: {
            evalReplayInvocationId: runInput.evalReplayInvocationId,
          },
        });
        store.append({ runId, type: "run.failed", payload: { error: "stage failed" } });
        store.close();
        throw new Error("ordinary operation failed");
      },
    })).rejects.toThrow("ordinary operation failed");

    const store = new EventStore(eventStorePath(fixture.repoPath));
    const linked = store.list("eval-failed-run").find(
      (event) => event.type === "eval.replay.linked",
    );
    store.close();
    expect(linked?.payload).toEqual(expect.objectContaining({
      caseId: "upgrade-zod",
      outcome: "failed",
    }));
  });

  it("fails closed when link storage cannot open after a successful terminal run", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");
    let storeOpenCount = 0;

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-link-open-failed",
      openEventStore: (path) => {
        storeOpenCount += 1;
        if (storeOpenCount === 2) throw new Error("link store open failed");
        return new EventStore(path);
      },
      runOrdinaryFlow: async (runInput, runId) => {
        const store = new EventStore(eventStorePath(fixture.repoPath));
        store.append({
          runId,
          type: "run.created",
          payload: {
            evalReplayInvocationId: runInput.evalReplayInvocationId,
          },
        });
        store.append({ runId, type: "run.completed", payload: {} });
        store.close();
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(fixture.repoPath, ".nitely/runs", runId, "worktree"),
        };
      },
    })).rejects.toThrow("link store open failed");
  });

  it("preserves both operation and link append failures", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");
    let storeOpenCount = 0;
    class AppendFailingEventStore extends EventStore {
      override append(): never {
        throw new Error("link append failed");
      }
    }
    let thrown: unknown;

    try {
      await executeEvalReplay(plan, {
        createRunId: () => "eval-double-failed",
        openEventStore: (path) => {
          storeOpenCount += 1;
          return storeOpenCount === 2
            ? new AppendFailingEventStore(path)
            : new EventStore(path);
        },
        runOrdinaryFlow: async (runInput, runId) => {
          const store = new EventStore(eventStorePath(fixture.repoPath));
          store.append({
            runId,
            type: "run.created",
            payload: {
              evalReplayInvocationId: runInput.evalReplayInvocationId,
            },
          });
          store.append({ runId, type: "run.failed", payload: { error: "failed" } });
          store.close();
          throw new Error("ordinary operation failed");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "ordinary operation failed" }),
      expect.objectContaining({ message: "link append failed" }),
    ]);
  });

  it("revalidates pinned repository state immediately before execution", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");
    await writeFile(join(fixture.repoPath, "fixtures/ticket.md"), "changed after planning\n");
    let runnerCalls = 0;

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-toctou",
      runOrdinaryFlow: async () => {
        runnerCalls += 1;
        throw new Error("runner must not be called");
      },
    })).rejects.toThrow(/content_digest_mismatch/);

    expect(runnerCalls).toBe(0);
  });

  it("refuses invalid link provenance and a runner result for a different run id", async () => {
    const fixture = await createReplayFixture();
    const plan = await planEvalReplay({
      repoPath: fixture.repoPath,
      manifest: fixture.manifest,
      manifestSha256: evalManifestSha256(fixture.manifest),
      caseId: "upgrade-zod",
    });
    expect(plan.status).toBe("ready");

    await expect(executeEvalReplay(plan, {
      createRunId: () => "eval-expected",
      runOrdinaryFlow: async () => ({
        runId: "eval-wrong",
        branchName: "nitely/eval-wrong",
        worktreePath: join(fixture.repoPath, ".nitely/runs/eval-wrong/worktree"),
      }),
    })).rejects.toThrow(/ordinary runner returned run id eval-wrong, expected eval-expected/);

    const forged = structuredClone(plan);
    forged.manifestSha256 = "sha256:invalid";
    let calls = 0;
    await expect(executeEvalReplay(forged, {
      runOrdinaryFlow: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    })).rejects.toThrow(/invalid eval manifest digest/);
    expect(calls).toBe(0);
  });
});
