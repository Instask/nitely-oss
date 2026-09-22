import { describe, expect, it } from "vitest";

import { flowSchema } from "../../src/flow/schema.js";
import {
  externalKnowledgeAdmissionControls,
  externalKnowledgeQueryFailureIsFatal,
  resolveExternalKnowledgeControls,
  verifyKnowledgeSnapshotSetForResume,
} from "../../src/run/run-flow.js";

describe("external knowledge flow controls", () => {
  it("parses bounded named knowledge controls", () => {
    const parsed = flowSchema.parse({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "knowledge-controls" },
      spec: {
        context: {
          externalKnowledge: {
            ids: ["platform-standards"],
            topK: 8,
            maxPromptTokens: 2_400,
            availability: "required",
          },
        },
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the approved design.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    });

    expect(parsed.spec.context?.externalKnowledge).toEqual({
      ids: ["platform-standards"],
      topK: 8,
      maxPromptTokens: 2_400,
      availability: "required",
    });
  });

  it("merges flow and stage controls without widening access or budgets", () => {
    expect(
      resolveExternalKnowledgeControls({
        inheritedDefault: true,
        flow: {
          ids: ["platform", "security"],
          topK: 10,
          maxPromptTokens: 3_000,
          availability: "required",
        },
        stage: {
          ids: ["platform", "product"],
          topK: 4,
          maxPromptTokens: 1_200,
          availability: "degraded-ok",
        },
      }),
    ).toEqual({
      enabled: true,
      ids: ["platform"],
      topK: 4,
      maxPromptTokens: 1_200,
      availability: "required",
    });
  });

  it("keeps isolated stages disabled unless explicitly enabled and honors deny", () => {
    expect(
      resolveExternalKnowledgeControls({
        inheritedDefault: false,
      }).enabled,
    ).toBe(false);
    expect(
      resolveExternalKnowledgeControls({
        inheritedDefault: false,
        stage: { enabled: true },
      }).enabled,
    ).toBe(true);
    expect(
      resolveExternalKnowledgeControls({
        inheritedDefault: true,
        flow: false,
        stage: { enabled: true },
      }).enabled,
    ).toBe(false);
  });

  it("preserves a limit configured at only one level", () => {
    expect(resolveExternalKnowledgeControls({
      inheritedDefault: true,
      flow: { topK: 8, maxPromptTokens: 2_400 },
    })).toMatchObject({ topK: 8, maxPromptTokens: 2_400 });
  });

  it("keeps required attachment ids separate from optional stage selections", () => {
    const parsed = flowSchema.parse({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "stage-knowledge-requirements" },
      spec: {
        stages: [
          {
            id: "optional",
            type: "agent",
            runtime: "codex",
            prompt: "Use any available guidance.",
            inputs: [],
            outputs: ["optional-output"],
            context: { externalKnowledge: true },
          },
          {
            id: "required",
            type: "agent",
            runtime: "codex",
            prompt: "Use security guidance.",
            inputs: [],
            outputs: ["required-output"],
            context: {
              externalKnowledge: {
                ids: ["security"],
                availability: "required",
              },
            },
          },
        ],
      },
    });

    expect(externalKnowledgeAdmissionControls(parsed)).toEqual({
      requiredIds: ["security"],
      availability: "degraded-ok",
    });
  });

  it("fails closed when required flow and stage scopes do not intersect", () => {
    const parsed = flowSchema.parse({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "disjoint-required-knowledge" },
      spec: {
        context: {
          externalKnowledge: { ids: ["platform"] },
        },
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Use the required security guidance.",
            inputs: [],
            outputs: ["implementation"],
            context: {
              externalKnowledge: {
                ids: ["security"],
                availability: "required",
              },
            },
          },
        ],
      },
    });

    expect(() => externalKnowledgeAdmissionControls(parsed)).toThrow(
      /required external knowledge selection is empty/i,
    );
  });

  it("keeps attachment-global required failures fatal in optional stages", () => {
    expect(externalKnowledgeQueryFailureIsFatal({
      availability: "degraded-ok",
      pins: [{ attachmentRequired: true }],
    })).toBe(true);
    expect(externalKnowledgeQueryFailureIsFatal({
      availability: "degraded-ok",
      pins: [{ attachmentRequired: false }],
    })).toBe(false);
    expect(externalKnowledgeQueryFailureIsFatal({
      availability: "required",
      pins: [{ attachmentRequired: false }],
    })).toBe(true);
  });

  it("fails resume verification when admitted knowledge pins are missing or changed", () => {
    const pins = {
      version: 1 as const,
      pinnedAt: "2026-07-21T00:00:00.000Z",
      attachments: [{
        attachmentId: "security",
        snapshotId: "a".repeat(64),
        commitSha: "b".repeat(40),
        indexDigest: "sha256:" + "c".repeat(64),
        policyFingerprint: "sha256:" + "d".repeat(64),
        providerId: "local-hash",
        model: "unicode-hash-v1",
        providerConfigurationDigest: "sha256:" + "e".repeat(64),
        topK: 6,
        maxPromptTokens: 2_000,
        attachmentRequired: false,
        required: true,
      }],
      degradedAttachmentIds: [],
    };
    expect(verifyKnowledgeSnapshotSetForResume(pins, pins)).toEqual(pins);
    expect(() => verifyKnowledgeSnapshotSetForResume(pins, undefined)).toThrow(/missing/);
    expect(() => verifyKnowledgeSnapshotSetForResume(pins, {
      ...pins,
      attachments: [{ ...pins.attachments[0]!, commitSha: "f".repeat(40) }],
    })).toThrow(/does not match/);
  });

  it("rejects unsafe budgets and empty id filters", () => {
    const base = {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "invalid-knowledge-controls" },
      spec: {
        context: {
          externalKnowledge: {
            ids: [],
            topK: 0,
          },
        },
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    };
    expect(flowSchema.safeParse(base).success).toBe(false);
    expect(flowSchema.safeParse({
      ...base,
      spec: {
        ...base.spec,
        context: { externalKnowledge: { maxPromptTokens: 32_769 } },
      },
    }).success).toBe(false);
  });
});
