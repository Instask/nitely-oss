import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CommandResult,
  RunCommandOptions,
} from "../../src/run/execution/types.js";

export interface DurableReleaseReceipt {
  idempotencyKey: string;
  runId: string;
  stageId: string;
  rollbackBaseline: string;
  provenanceAttempts: number[];
  transitions: string[];
  evidence?: {
    releaseReport: string;
    smokeReport: string;
  };
  terminalError?: string;
  phase:
    | "baseline-captured"
    | "merged"
    | "deployed"
    | "completed"
    | "rolled-back";
}

export interface FakeReleaseEnvironmentState {
  rollbackBaseline: string;
  scmHead: string;
  productionSha: string;
  operationTokens: {
    merge?: string;
    deploy?: string;
    rollback?: string;
  };
  mergeMutations: number;
  deployMutations: number;
  rollbackMutations: number;
  mutationLog: string[];
}

export interface ReleaseFixturePaths {
  idempotencyKey: string;
  receiptPath: string;
  lockPath: string;
  externalStatePath: string;
}

export interface DurableReleaseAdapterFixture {
  paths: ReleaseFixturePaths;
  runCommand(options: RunCommandOptions): Promise<CommandResult>;
}

export interface ReleaseDurabilityEvent {
  type:
    | "directory-created"
    | "directory-synced"
    | "atomic-write-started"
    | "lock-open-started";
  directory: string;
  path?: string;
}

type ReleaseDurabilityObserver = (event: ReleaseDurabilityEvent) => void;

const releaseBaseline = "production-sha-before-release";
const releaseSha = "release-sha";

export function releaseFixturePaths(
  repo: string,
  runId: string,
): ReleaseFixturePaths {
  return {
    idempotencyKey: `${runId}:release`,
    receiptPath: join(repo, ".release-receipts", `${runId}--release.json`),
    lockPath: join(repo, ".release-locks", `${runId}--release.sqlite`),
    externalStatePath: join(
      repo,
      ".fake-release-state",
      `${runId}--release.json`,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateDurableReleaseReceipt(
  value: unknown,
  input: { runId: string; idempotencyKey: string },
): DurableReleaseReceipt {
  if (!isRecord(value)) throw new Error("receipt must be an object");
  const phases = new Set<DurableReleaseReceipt["phase"]>([
    "baseline-captured",
    "merged",
    "deployed",
    "completed",
    "rolled-back",
  ]);
  if (
    value.idempotencyKey !== input.idempotencyKey ||
    value.runId !== input.runId ||
    value.stageId !== "release"
  ) {
    throw new Error(
      "receipt identity does not match NITELY_RUN_ID and NITELY_STAGE_ID",
    );
  }
  if (value.rollbackBaseline !== releaseBaseline) {
    throw new Error("receipt rollback baseline is invalid");
  }
  if (
    !Array.isArray(value.provenanceAttempts) ||
    !value.provenanceAttempts.every(
      (attempt) => Number.isInteger(attempt) && Number(attempt) > 0,
    )
  ) {
    throw new Error("receipt attempt provenance is invalid");
  }
  if (
    !Array.isArray(value.transitions) ||
    !value.transitions.every((transition) => typeof transition === "string")
  ) {
    throw new Error("receipt transitions are invalid");
  }
  if (!phases.has(value.phase as DurableReleaseReceipt["phase"])) {
    throw new Error("receipt phase is invalid");
  }
  if (value.evidence !== undefined) {
    if (
      !isRecord(value.evidence) ||
      typeof value.evidence.releaseReport !== "string" ||
      typeof value.evidence.smokeReport !== "string"
    ) {
      throw new Error("receipt evidence is invalid");
    }
  }
  if (value.phase === "completed" && value.evidence === undefined) {
    throw new Error("completed receipt is missing durable evidence");
  }
  if (
    value.terminalError !== undefined &&
    !isNonBlankString(value.terminalError)
  ) {
    throw new Error("receipt terminal error is invalid");
  }
  if (value.phase === "rolled-back" && value.terminalError === undefined) {
    throw new Error("rolled-back receipt is missing its terminal error");
  }
  return value as unknown as DurableReleaseReceipt;
}

function validateFakeReleaseEnvironmentState(
  value: unknown,
): FakeReleaseEnvironmentState {
  if (!isRecord(value)) throw new Error("external release state must be an object");
  if (
    value.rollbackBaseline !== releaseBaseline ||
    typeof value.scmHead !== "string" ||
    typeof value.productionSha !== "string" ||
    !isRecord(value.operationTokens)
  ) {
    throw new Error("external release identity state is invalid");
  }
  for (const token of Object.values(value.operationTokens)) {
    if (!isNonBlankString(token)) {
      throw new Error("external release operation token is invalid");
    }
  }
  for (const count of [
    value.mergeMutations,
    value.deployMutations,
    value.rollbackMutations,
  ]) {
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new Error("external release mutation count is invalid");
    }
  }
  if (
    !Array.isArray(value.mutationLog) ||
    !value.mutationLog.every((entry) => typeof entry === "string")
  ) {
    throw new Error("external release mutation log is invalid");
  }
  return value as unknown as FakeReleaseEnvironmentState;
}

function validateReleaseStateConsistency(
  receipt: DurableReleaseReceipt,
  externalState: FakeReleaseEnvironmentState,
): void {
  if (externalState.rollbackBaseline !== receipt.rollbackBaseline) {
    throw new Error("receipt and external rollback baselines disagree");
  }
  const merged = externalState.operationTokens.merge !== undefined;
  const deployed = externalState.operationTokens.deploy !== undefined;
  const rolledBack = externalState.operationTokens.rollback !== undefined;
  if (merged !== (externalState.mergeMutations === 1)) {
    throw new Error("merge token and mutation count disagree");
  }
  if (deployed !== (externalState.deployMutations === 1)) {
    throw new Error("deploy token and mutation count disagree");
  }
  if (rolledBack !== (externalState.rollbackMutations === 1)) {
    throw new Error("rollback token and mutation count disagree");
  }
  if (merged && externalState.scmHead !== releaseSha) {
    throw new Error("merge token does not match SCM state");
  }
  if (!merged && externalState.scmHead !== releaseBaseline) {
    throw new Error("SCM state changed without a merge token");
  }
  if (deployed && !rolledBack && externalState.productionSha !== releaseSha) {
    throw new Error("deploy token does not match production state");
  }
  if (
    (!deployed || rolledBack) &&
    externalState.productionSha !== releaseBaseline
  ) {
    throw new Error("production state does not match the rollback baseline");
  }
  if (
    (receipt.phase === "merged" ||
      receipt.phase === "deployed" ||
      receipt.phase === "completed" ||
      receipt.phase === "rolled-back") &&
    !merged
  ) {
    throw new Error(`receipt phase ${receipt.phase} requires an observed merge`);
  }
  if (
    (receipt.phase === "deployed" ||
      receipt.phase === "completed" ||
      receipt.phase === "rolled-back") &&
    !deployed
  ) {
    throw new Error(`receipt phase ${receipt.phase} requires an observed deploy`);
  }
  if (receipt.phase === "rolled-back" && !rolledBack) {
    throw new Error("rolled-back receipt requires an observed rollback");
  }
  if (
    rolledBack &&
    receipt.phase !== "rolled-back" &&
    !(receipt.phase === "deployed" && receipt.terminalError !== undefined)
  ) {
    throw new Error("external rollback is inconsistent with the receipt phase");
  }
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(
  directory: string,
  path: string,
  observeDurability?: ReleaseDurabilityObserver,
): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  observeDurability?.({ type: "directory-synced", directory, path });
}

async function ensureDurableDirectory(
  directory: string,
  durableRoot: string,
  observeDurability?: ReleaseDurabilityObserver,
): Promise<void> {
  const root = resolve(durableRoot);
  const target = resolve(directory);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`durability root is not a real directory: ${root}`);
  }
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(
      `durable directory ${target} is outside durability root ${root}`,
    );
  }
  if (pathFromRoot === "") return;

  let parent = root;
  for (const component of pathFromRoot.split(sep)) {
    const child = join(parent, component);
    let created = false;
    try {
      await mkdir(child);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const childStats = await lstat(child);
      if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
        throw new Error(`durable path component is not a real directory: ${child}`);
      }
    }
    if (created) {
      observeDurability?.({ type: "directory-created", directory: child });
    }
    // Resync every link on every invocation. This closes both the competing
    // creator race and a retry after any prior parent-directory fsync failure.
    await syncDirectory(parent, child, observeDurability);
    parent = child;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
  observeDurability?: ReleaseDurabilityObserver,
): Promise<void> {
  const directory = dirname(path);
  await ensureDurableDirectory(
    directory,
    dirname(directory),
    observeDurability,
  );
  observeDurability?.({ type: "atomic-write-started", directory, path });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    renamed = true;
    await syncDirectory(directory, path, observeDurability);
  } catch (error) {
    if (!renamed) await rm(temporaryPath, { force: true });
    throw error;
  }
}

const inProcessReceiptLockTails = new Map<string, Promise<void>>();

async function withInProcessReceiptLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor =
    inProcessReceiptLockTails.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const ownership = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => ownership);
  inProcessReceiptLockTails.set(lockPath, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (inProcessReceiptLockTails.get(lockPath) === tail) {
      inProcessReceiptLockTails.delete(lockPath);
    }
  }
}

async function withExclusiveReceiptLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  durableRoot: string,
  observeDurability?: ReleaseDurabilityObserver,
): Promise<T> {
  return await withInProcessReceiptLock(lockPath, async () => {
    const directory = dirname(lockPath);
    await ensureDurableDirectory(directory, durableRoot, observeDurability);
    observeDurability?.({
      type: "lock-open-started",
      directory,
      path: lockPath,
    });
    const database = new DatabaseSync(lockPath);
    let transactionOpen = false;
    try {
      await syncDirectory(directory, lockPath, observeDurability);
      database.exec("PRAGMA busy_timeout = 30000");
      database.exec("BEGIN EXCLUSIVE");
      transactionOpen = true;
      const result = await operation();
      database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The original release error remains authoritative.
        }
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

function initialReleaseEnvironmentState(): FakeReleaseEnvironmentState {
  return {
    rollbackBaseline: releaseBaseline,
    scmHead: releaseBaseline,
    productionSha: releaseBaseline,
    operationTokens: {},
    mergeMutations: 0,
    deployMutations: 0,
    rollbackMutations: 0,
    mutationLog: [],
  };
}

function isExactlyPristineExternalState(
  value: unknown,
  state: FakeReleaseEnvironmentState,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "deployMutations",
    "mergeMutations",
    "mutationLog",
    "operationTokens",
    "productionSha",
    "rollbackBaseline",
    "rollbackMutations",
    "scmHead",
  ];
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    Object.keys(state.operationTokens).length === 0 &&
    state.rollbackBaseline === releaseBaseline &&
    state.scmHead === releaseBaseline &&
    state.productionSha === releaseBaseline &&
    state.mergeMutations === 0 &&
    state.deployMutations === 0 &&
    state.rollbackMutations === 0 &&
    state.mutationLog.length === 0
  );
}

function initialReleaseReceipt(input: {
  runId: string;
  attempt: number;
  idempotencyKey: string;
}): DurableReleaseReceipt {
  return {
    idempotencyKey: input.idempotencyKey,
    runId: input.runId,
    stageId: "release",
    rollbackBaseline: releaseBaseline,
    provenanceAttempts: [input.attempt],
    transitions: ["baseline-captured"],
    phase: "baseline-captured",
  };
}

function invalidReceiptResult(error: unknown): CommandResult {
  return {
    stdout: "",
    stderr: `invalid durable release receipt: ${error instanceof Error ? error.message : String(error)}\n`,
    exitCode: 78,
  };
}

async function loadOrInitializeReleaseState(input: {
  paths: ReleaseFixturePaths;
  runId: string;
  attempt: number;
  interruptAfterInitialExternalState?: () => never;
  observeDurability?: ReleaseDurabilityObserver;
}): Promise<{
  receipt: DurableReleaseReceipt;
  externalState: FakeReleaseEnvironmentState;
}> {
  const receiptValue = await readJsonIfPresent(input.paths.receiptPath);
  const externalStateValue = await readJsonIfPresent(
    input.paths.externalStatePath,
  );
  if (receiptValue !== undefined && externalStateValue === undefined) {
    throw new Error(
      "receipt and external release state must either both exist or both be absent",
    );
  }
  if (receiptValue !== undefined && externalStateValue !== undefined) {
    const receipt = validateDurableReleaseReceipt(receiptValue, {
      runId: input.runId,
      idempotencyKey: input.paths.idempotencyKey,
    });
    const externalState =
      validateFakeReleaseEnvironmentState(externalStateValue);
    validateReleaseStateConsistency(receipt, externalState);
    receipt.provenanceAttempts.push(input.attempt);
    return { receipt, externalState };
  }

  if (externalStateValue !== undefined) {
    const externalState =
      validateFakeReleaseEnvironmentState(externalStateValue);
    if (!isExactlyPristineExternalState(externalStateValue, externalState)) {
      throw new Error(
        "external-only release state is not an exact pristine initialization",
      );
    }
    const receipt = initialReleaseReceipt({
      runId: input.runId,
      attempt: input.attempt,
      idempotencyKey: input.paths.idempotencyKey,
    });
    await writeJsonAtomically(
      input.paths.receiptPath,
      receipt,
      input.observeDurability,
    );
    return { receipt, externalState };
  }

  const externalState = initialReleaseEnvironmentState();
  await writeJsonAtomically(
    input.paths.externalStatePath,
    externalState,
    input.observeDurability,
  );
  if (input.interruptAfterInitialExternalState) {
    input.interruptAfterInitialExternalState();
  }
  const receipt = initialReleaseReceipt({
    runId: input.runId,
    attempt: input.attempt,
    idempotencyKey: input.paths.idempotencyKey,
  });
  await writeJsonAtomically(
    input.paths.receiptPath,
    receipt,
    input.observeDurability,
  );
  return { receipt, externalState };
}

async function reconcileMerge(
  paths: ReleaseFixturePaths,
  state: {
    receipt: DurableReleaseReceipt;
    externalState: FakeReleaseEnvironmentState;
  },
  observeDurability?: ReleaseDurabilityObserver,
): Promise<void> {
  if (state.receipt.phase !== "baseline-captured") return;
  if (state.externalState.operationTokens.merge === undefined) {
    state.externalState.scmHead = releaseSha;
    state.externalState.operationTokens.merge = `${paths.idempotencyKey}:merge`;
    state.externalState.mergeMutations += 1;
    state.externalState.mutationLog.push("merge");
    await writeJsonAtomically(
      paths.externalStatePath,
      state.externalState,
      observeDurability,
    );
    state.receipt.transitions.push("merge-recorded");
  } else {
    state.receipt.transitions.push("merge-reconciled");
  }
  state.receipt.phase = "merged";
  await writeJsonAtomically(
    paths.receiptPath,
    state.receipt,
    observeDurability,
  );
}

async function reconcileDeploy(
  paths: ReleaseFixturePaths,
  state: {
    receipt: DurableReleaseReceipt;
    externalState: FakeReleaseEnvironmentState;
  },
  interruptAfterDeploy?: () => never,
  observeDurability?: ReleaseDurabilityObserver,
): Promise<void> {
  if (state.receipt.phase !== "merged") return;
  if (state.externalState.operationTokens.deploy === undefined) {
    state.externalState.productionSha = releaseSha;
    state.externalState.operationTokens.deploy = `${paths.idempotencyKey}:deploy`;
    state.externalState.deployMutations += 1;
    state.externalState.mutationLog.push("deploy");
    await writeJsonAtomically(
      paths.externalStatePath,
      state.externalState,
      observeDurability,
    );
    if (interruptAfterDeploy) interruptAfterDeploy();
    state.receipt.transitions.push("deploy-recorded");
  } else {
    state.receipt.transitions.push("deploy-reconciled");
  }
  state.receipt.phase = "deployed";
  await writeJsonAtomically(
    paths.receiptPath,
    state.receipt,
    observeDurability,
  );
}

async function finishRollback(input: {
  paths: ReleaseFixturePaths;
  receipt: DurableReleaseReceipt;
  externalState: FakeReleaseEnvironmentState;
  observeDurability?: ReleaseDurabilityObserver;
}): Promise<CommandResult> {
  const reconciled = input.externalState.operationTokens.rollback !== undefined;
  if (input.externalState.operationTokens.rollback === undefined) {
    input.externalState.productionSha = input.externalState.rollbackBaseline;
    input.externalState.operationTokens.rollback =
      `${input.paths.idempotencyKey}:rollback`;
    input.externalState.rollbackMutations += 1;
    input.externalState.mutationLog.push("rollback");
    await writeJsonAtomically(
      input.paths.externalStatePath,
      input.externalState,
      input.observeDurability,
    );
  }
  input.receipt.phase = "rolled-back";
  input.receipt.transitions.push(
    reconciled ? "rollback-reconciled" : "rollback-recorded",
  );
  await writeJsonAtomically(
    input.paths.receiptPath,
    input.receipt,
    input.observeDurability,
  );
  return {
    stdout: "",
    stderr: `${input.receipt.terminalError ?? "release rolled back"}\n`,
    exitCode: 70,
  };
}

async function recordRollback(input: {
  paths: ReleaseFixturePaths;
  receipt: DurableReleaseReceipt;
  externalState: FakeReleaseEnvironmentState;
  terminalError: string;
  observeDurability?: ReleaseDurabilityObserver;
}): Promise<CommandResult> {
  input.receipt.terminalError = input.terminalError;
  input.receipt.transitions.push("post-deploy-failure-observed");
  await writeJsonAtomically(
    input.paths.receiptPath,
    input.receipt,
    input.observeDurability,
  );
  return await finishRollback(input);
}

async function materializeSuccessfulEvidence(input: {
  paths: ReleaseFixturePaths;
  receipt: DurableReleaseReceipt;
  outputDirectory: string;
  observeDurability?: ReleaseDurabilityObserver;
}): Promise<CommandResult> {
  const wasCompleted = input.receipt.phase === "completed";
  const evidence = input.receipt.evidence ?? {
    releaseReport: [
      "# Release report",
      "",
      `Identity: ${input.receipt.idempotencyKey}`,
      `Rollback baseline: ${input.receipt.rollbackBaseline}`,
      "Reconciled an already-deployed release without repeating mutation.",
      "",
    ].join("\n"),
    smokeReport:
      "# Smoke report\n\nProduction is healthy after reconciliation.\n",
  };
  await writeFile(
    join(input.outputDirectory, "release-report.md"),
    evidence.releaseReport,
    "utf8",
  );
  await writeFile(
    join(input.outputDirectory, "smoke-report.md"),
    evidence.smokeReport,
    "utf8",
  );
  input.receipt.evidence = evidence;
  input.receipt.phase = "completed";
  input.receipt.transitions.push(
    wasCompleted ? "completed-evidence-replayed" : "reports-completed",
  );
  await writeJsonAtomically(
    input.paths.receiptPath,
    input.receipt,
    input.observeDurability,
  );
  return { stdout: "release reconciled\n", stderr: "", exitCode: 0 };
}

export function createDurableReleaseAdapterFixture(input: {
  repo: string;
  durabilityRoot?: string;
  runId: string;
  interruptAfterDeploy?: () => never;
  interruptAfterInitialExternalState?: () => never;
  terminalFailureAfterDeploy?: string;
  observeDurability?: ReleaseDurabilityObserver;
}): DurableReleaseAdapterFixture {
  if (
    input.terminalFailureAfterDeploy !== undefined &&
    !isNonBlankString(input.terminalFailureAfterDeploy)
  ) {
    throw new Error("terminal failure injection must be a non-blank string");
  }
  const paths = releaseFixturePaths(input.repo, input.runId);
  return {
    paths,
    async runCommand(options) {
      if (
        options.runId !== input.runId ||
        options.stageId !== "release" ||
        !Number.isInteger(options.attempt) ||
        !options.outputDirectory
      ) {
        return invalidReceiptResult(
          new Error("runtime-owned release identity is missing or invalid"),
        );
      }
      return await withExclusiveReceiptLock(paths.lockPath, async () => {
        let state: Awaited<ReturnType<typeof loadOrInitializeReleaseState>>;
        try {
          state = await loadOrInitializeReleaseState({
            paths,
            runId: input.runId,
            attempt: options.attempt!,
            interruptAfterInitialExternalState:
              input.interruptAfterInitialExternalState,
            observeDurability: input.observeDurability,
          });
        } catch (error) {
          return invalidReceiptResult(error);
        }

        if (
          state.receipt.phase === "deployed" &&
          state.receipt.terminalError !== undefined
        ) {
          return await finishRollback({
            paths,
            ...state,
            observeDurability: input.observeDurability,
          });
        }
        if (state.receipt.phase === "rolled-back") {
          await writeJsonAtomically(
            paths.receiptPath,
            state.receipt,
            input.observeDurability,
          );
          return {
            stdout: "",
            stderr: `${state.receipt.terminalError ?? "release previously rolled back"}\n`,
            exitCode: 70,
          };
        }

        await reconcileMerge(paths, state, input.observeDurability);
        await reconcileDeploy(
          paths,
          state,
          input.interruptAfterDeploy,
          input.observeDurability,
        );
        if (
          state.receipt.phase === "deployed" &&
          input.terminalFailureAfterDeploy !== undefined
        ) {
          return await recordRollback({
            paths,
            ...state,
            terminalError: input.terminalFailureAfterDeploy,
            observeDurability: input.observeDurability,
          });
        }
        return await materializeSuccessfulEvidence({
          paths,
          receipt: state.receipt,
          outputDirectory: options.outputDirectory!,
          observeDurability: input.observeDurability,
        });
      }, input.durabilityRoot ?? input.repo, input.observeDurability);
    },
  };
}

export async function seedReleaseFixtureState(input: {
  repo: string;
  runId: string;
  phase: Exclude<DurableReleaseReceipt["phase"], "rolled-back">;
  externalMergeAhead?: boolean;
}): Promise<{
  paths: ReleaseFixturePaths;
  completedEvidence: NonNullable<DurableReleaseReceipt["evidence"]>;
}> {
  const paths = releaseFixturePaths(input.repo, input.runId);
  const completedEvidence = {
    releaseReport: `# Original release evidence\n\n${input.phase}\n`,
    smokeReport: `# Original smoke evidence\n\n${input.phase}\n`,
  };
  const merged =
    input.externalMergeAhead ||
    input.phase === "merged" ||
    input.phase === "deployed" ||
    input.phase === "completed";
  const deployed = input.phase === "deployed" || input.phase === "completed";
  const receipt: DurableReleaseReceipt = {
    idempotencyKey: paths.idempotencyKey,
    runId: input.runId,
    stageId: "release",
    rollbackBaseline: releaseBaseline,
    provenanceAttempts: [1],
    transitions: [`seeded-${input.phase}`],
    ...(input.phase === "completed" ? { evidence: completedEvidence } : {}),
    phase: input.phase,
  };
  const externalState: FakeReleaseEnvironmentState = {
    rollbackBaseline: releaseBaseline,
    scmHead: merged ? releaseSha : releaseBaseline,
    productionSha: deployed ? releaseSha : releaseBaseline,
    operationTokens: {
      ...(merged ? { merge: "observed:merge" } : {}),
      ...(deployed ? { deploy: "observed:deploy" } : {}),
    },
    mergeMutations: merged ? 1 : 0,
    deployMutations: deployed ? 1 : 0,
    rollbackMutations: 0,
    mutationLog: [
      ...(merged ? ["merge"] : []),
      ...(deployed ? ["deploy"] : []),
    ],
  };
  await writeJsonAtomically(paths.receiptPath, receipt);
  await writeJsonAtomically(paths.externalStatePath, externalState);
  return { paths, completedEvidence };
}

export async function seedRollbackRecoveryFixtureState(input: {
  repo: string;
  runId: string;
  externalRollbackApplied: boolean;
}): Promise<ReleaseFixturePaths> {
  const paths = releaseFixturePaths(input.repo, input.runId);
  const receipt: DurableReleaseReceipt = {
    idempotencyKey: paths.idempotencyKey,
    runId: input.runId,
    stageId: "release",
    rollbackBaseline: releaseBaseline,
    provenanceAttempts: [1],
    transitions: [
      "baseline-captured",
      "merge-recorded",
      "deploy-recorded",
      "post-deploy-failure-observed",
    ],
    terminalError: "post-deploy verification failed",
    phase: "deployed",
  };
  const externalState: FakeReleaseEnvironmentState = {
    rollbackBaseline: releaseBaseline,
    scmHead: releaseSha,
    productionSha: input.externalRollbackApplied ? releaseBaseline : releaseSha,
    operationTokens: {
      merge: `${paths.idempotencyKey}:merge`,
      deploy: `${paths.idempotencyKey}:deploy`,
      ...(input.externalRollbackApplied
        ? { rollback: `${paths.idempotencyKey}:rollback` }
        : {}),
    },
    mergeMutations: 1,
    deployMutations: 1,
    rollbackMutations: input.externalRollbackApplied ? 1 : 0,
    mutationLog: [
      "merge",
      "deploy",
      ...(input.externalRollbackApplied ? ["rollback"] : []),
    ],
  };
  await writeJsonAtomically(paths.receiptPath, receipt);
  await writeJsonAtomically(paths.externalStatePath, externalState);
  return paths;
}

export async function readReleaseFixtureState(
  repo: string,
  runId: string,
): Promise<{
  receipt: DurableReleaseReceipt;
  externalState: FakeReleaseEnvironmentState;
}> {
  const paths = releaseFixturePaths(repo, runId);
  const receipt = validateDurableReleaseReceipt(
    JSON.parse(await readFile(paths.receiptPath, "utf8")),
    { runId, idempotencyKey: paths.idempotencyKey },
  );
  const externalState = validateFakeReleaseEnvironmentState(
    JSON.parse(await readFile(paths.externalStatePath, "utf8")),
  );
  validateReleaseStateConsistency(receipt, externalState);
  return { receipt, externalState };
}
