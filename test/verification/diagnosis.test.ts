import { describe, expect, it } from "vitest";
import { parseFlowDocument } from "../../src/flow/load.js";
import { diagnoseVerificationFailure } from "../../src/verification/diagnosis.js";

const loaded = parseFlowDocument(JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "diagnosis-unit" },
  spec: {
    stages: [
      { id: "implement", type: "agent", runtime: "codex", prompt: "Implement.", inputs: [], outputs: ["implementation"] },
      { id: "test", type: "command", command: "pnpm exec vitest run", inputs: ["implementation"], outputs: ["test-report"] },
    ],
  },
}));

function diagnose(error: string, attempt = 1) {
  const stage = loaded.flow.spec.stages.find((candidate) => candidate.id === "test")!;
  return diagnoseVerificationFailure({
    stage,
    stages: loaded.flow.spec.stages,
    graph: loaded.graph,
    attempt,
    maxAttempts: 2,
    error,
    validReworkTargets: new Set(["implementation"]),
    validReworkStages: new Set(["implement", "test"]),
  });
}

// Shape of a real vitest run (Linux runner, 2026-10-06): passing files whose
// names and console output contain environment-looking words, plus one test
// file that fails to load because of a broken import.
const VITEST_LOG = [
  " RUN  v4.1.11 /workspace",
  "",
  " ✓ test/artifacts/registry.test.ts (26 tests) 476ms",
  " ✓ test/run/execution/network-gateway.test.ts (18 tests) 108ms",
  " ✓ test/preview/manager.test.ts (8 tests) 637ms",
  "   ✓ records readiness timeout and cleans up the process tree 120ms",
  "stderr | test/run/execution/local.test.ts > describes provider failures",
  "codex diagnostic 429: {\"message\":\"Rate limit exceeded\",\"code\":429}",
  "502: {\"message\":\"Provider returned error\",\"code\":502}",
  "",
  " ❯ test/web/session-organization-switch.test.ts (0 test)",
  "",
  "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  test/web/session-organization-switch.test.ts [ test/web/session-organization-switch.test.ts ]",
  "Error: Cannot find module '../../providers/file-store.js' imported from /workspace/test/web/session-organization-switch.test.ts",
  " ❯ test/web/session-organization-switch.test.ts:10:1",
  "     10| import { FileProviderConnectionStore } from \"../../providers/file-store.js\";",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
  "",
  " Test Files  1 failed | 222 passed (223)",
  "      Tests  2745 passed | 6 skipped (2751)",
].join("\n");

describe("diagnoseVerificationFailure", () => {
  it("classifies a broken test import as implementation even when passing output mentions network, registry, timeout and 5xx", () => {
    const diagnosis = diagnose(VITEST_LOG);
    expect(diagnosis).toMatchObject({
      classification: "implementation",
      recommendedAction: "rework",
      targetStage: "implement",
      targetArtifact: "implementation",
    });
  });

  it("routes the repeated broken import to implementation rework instead of escalating as flaky", () => {
    expect(diagnose(VITEST_LOG, 2)).toMatchObject({ classification: "implementation", recommendedAction: "rework" });
  });

  it("puts the failing assertion, not the first lines of the log, into the rework evidence", () => {
    const evidence = diagnose(VITEST_LOG)!.evidence.join("\n");
    expect(evidence).toContain("Cannot find module '../../providers/file-store.js'");
    expect(evidence).not.toContain("RUN  v4.1.11");
    expect(evidence).not.toContain("network-gateway.test.ts");
  });

  it("still treats a failure whose own failing block is a network error as environmental", () => {
    const log = [
      " ✓ test/a.test.ts (3 tests) 12ms",
      " FAIL  test/b.test.ts > fetches the package index",
      "Error: getaddrinfo EAI_AGAIN registry.npmjs.org",
      " Test Files  1 failed | 1 passed (2)",
    ].join("\n");
    expect(diagnose(log)).toMatchObject({ classification: "environment", recommendedAction: "retry" });
    expect(diagnose(log, 2)).toMatchObject({ classification: "environment", recommendedAction: "escalate" });
  });

  it("reworks implementation when one failing block is environmental and another is a code failure", () => {
    const log = [
      " FAIL  test/web/mobile-viewport.test.ts > renders without overflow",
      "Error: connect ECONNREFUSED 127.0.0.1:9222",
      "",
      " FAIL  test/web/switch.test.ts > A1",
      "AssertionError: expected undefined to be 'org_b'",
    ].join("\n");
    expect(diagnose(log)).toMatchObject({ classification: "implementation", recommendedAction: "rework" });
  });

  it("classifies TypeScript compiler errors as implementation", () => {
    const log = [
      "$ tsc -p tsconfig.json --noEmit",
      "test/web/switch.test.ts(40,84): error TS2322: Type '{ organizationId: OrganizationRecord; }' is not assignable to type 'string'.",
    ].join("\n");
    expect(diagnose(log)).toMatchObject({ classification: "implementation", recommendedAction: "rework" });
  });

  it("reads failure blocks through the ANSI colors a real command failure carries", () => {
    // Shape of stage.failed.error on run 2026-10-07T111808093Z-294512c5:
    // exit summary first, colored stderr from passing tests, then colored FAIL blocks.
    const esc = "\u001b";
    const log = [
      "command failed with exit code 1: pnpm exec vitest run && pnpm run check && pnpm run build",
      `${esc}[90mstderr${esc}[2m | test/web/server.test.ts${esc}[2m > ${esc}[22m${esc}[2mweb server API and HTML`,
      `${esc}[22m${esc}[39mHome directory /tmp/nitely-web-server-hGad9q has runs but no registered repository (reason: no-origin).`,
      `${esc}[90mstderr${esc}[2m | test/run/execution/local.test.ts${esc}[2m > ${esc}[22mdescribes provider failures`,
      `${esc}[22m${esc}[39mcodex diagnostic 429: {"message":"Rate limit exceeded","code":429}`,
      ` ${esc}[32m✓${esc}[39m test/run/execution/network-gateway.test.ts ${esc}[2m(18 tests)${esc}[22m${esc}[33m 108${esc}[2mms${esc}[22m${esc}[39m`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m test/web/session-organization-switch.test.ts${esc}[2m > ${esc}[22mswitches current organization from A to B`,
      `${esc}[31m${esc}[1mAssertionError${esc}[22m: expected 3 to be 2 // Object.is equality${esc}[39m`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m test/web/session-organization-switch.test.ts${esc}[2m > ${esc}[22mAPI token requests get 404`,
      `${esc}[31m${esc}[1mAssertionError${esc}[22m: expected 401 to be 404 // Object.is equality${esc}[39m`,
    ].join("\n");
    const diagnosis = diagnose(log);
    expect(diagnosis).toMatchObject({ classification: "implementation", recommendedAction: "rework", targetStage: "implement" });
    const evidence = diagnosis!.evidence.join("\n");
    expect(evidence).toContain("AssertionError: expected 3 to be 2");
    expect(evidence).not.toContain(esc);
    expect(evidence).not.toContain("Rate limit exceeded");
  });

  it("keeps whole-text classification for unstructured command output", () => {
    expect(diagnose("curl: (6) Could not resolve host: example.com\nnetwork is unreachable")).toMatchObject({
      classification: "environment",
    });
  });
});
