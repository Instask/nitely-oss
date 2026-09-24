import { describe, expect, it } from "vitest";

import { formatExecutionBackendEvidence } from "../../../src/run/execution/evidence.js";

describe("formatExecutionBackendEvidence", () => {
  it("renders backend identity and effective policy without values", () => {
    const rendered = formatExecutionBackendEvidence({
      backend: "oci",
      engine: "docker-rootless",
      image: "nitely-runner:test",
      imageReference: "nitely-runner:test",
      imageIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyVersion: 1,
      isolation: "rootless-container",
      identity: {
        uid: 0,
        gid: 0,
        strategy: "rootless-container-root",
      },
      network: "none",
      mounts: ["task worktree", "attempt output"],
      environment: {
        allowedNames: ["LANG"],
        secretNames: ["OPENAI_API_KEY"],
        valuesRecorded: false,
      },
      commands: { mediation: "stated" },
      resources: {
        cpus: 1,
        memoryBytes: 1_073_741_824,
        pids: 128,
        tmpfsBytes: 268_435_456,
        maxFileBytes: 268_435_456,
        maxCapturedOutputBytes: 16_777_216,
        timeoutMs: 600_000,
      },
      cleanup: "run --rm plus forced rm -f",
      lifecycle: {
        managed: true,
        expiry: "effective timeout plus bounded cleanup grace",
        cleanupGraceMs: 30_000,
        labelKeys: ["com.nitely.managed"],
      },
      limitations: ["Git metadata is not mounted"],
    });

    expect(rendered).toContain("Backend: oci");
    expect(rendered).toContain("Engine: docker-rootless");
    expect(rendered).toContain("Image reference: nitely-runner:test");
    expect(rendered).toContain(
      "Image identity: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rendered).toContain("Policy version: 1");
    expect(rendered).toContain(
      "Identity: 0:0 (rootless-container-root)",
    );
    expect(rendered).toContain("Network: none");
    expect(rendered).toContain("Environment names: LANG");
    expect(rendered).toContain("Secret names: OPENAI_API_KEY (values omitted)");
    expect(rendered).toContain("CPU: 1");
    expect(rendered).toContain("Memory bytes: 1073741824");
    expect(rendered).toContain("Limitations: Git metadata is not mounted");
    expect(rendered).toContain("Container lifecycle: managed");
    expect(rendered).not.toContain("secret-value");
  });
});
