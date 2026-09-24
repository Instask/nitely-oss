import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MissingConnectionError } from "../providers/types.js";
import type { ProviderConnectionStore } from "../providers/types.js";
import { redactText } from "../context/redaction.js";
import { withKnowledgeLease } from "./lock.js";
import type { KnowledgeRepositoryPaths } from "./paths.js";
import { knowledgeMirrorPath, requireManagedKnowledgePath } from "./paths.js";
import {
  normalizeGitHubKnowledgeUrl,
  normalizeKnowledgeGitRef,
  type KnowledgeRepositoryRef,
  type KnowledgeRepositorySource,
} from "./schema.js";

const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface KnowledgeGitCommandInput {
  args: string[];
  env: Record<string, string>;
  maxBuffer: number;
}

export interface KnowledgeGitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

export type KnowledgeGitCommandRunner = (
  input: KnowledgeGitCommandInput,
) => Promise<KnowledgeGitCommandResult>;

export interface KnowledgeGitSnapshot {
  mirrorPath: string;
  commitSha: string;
  source: KnowledgeRepositorySource;
  ref: KnowledgeRepositoryRef;
}

export interface KnowledgeGitTreeEntry {
  mode: "100644" | "100755";
  objectId: string;
  size: number;
  path: string;
}

export class KnowledgeGitError extends Error {
  constructor(
    public readonly code:
      | "invalid-source"
      | "invalid-ref"
      | "source-unavailable"
      | "git-failed"
      | "unsafe-tree",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeGitError";
  }
}

const defaultRunner: KnowledgeGitCommandRunner = async (input) => {
  return await new Promise<KnowledgeGitCommandResult>((resolvePromise, reject) => {
    execFile(
      "git",
      input.args,
      {
        env: input.env,
        encoding: "buffer",
        maxBuffer: input.maxBuffer,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
        });
      },
    );
  });
};

function inheritedExecutableEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}

function gitEnvironment(input: {
  paths: KnowledgeRepositoryPaths;
  sourceEnv?: Record<string, string | undefined>;
  githubToken?: string;
  allowLocalProtocol?: boolean;
}): Record<string, string> {
  const configs: Array<[string, string]> = [
    ["credential.helper", ""],
    ["core.hooksPath", input.paths.gitHooksRoot],
    ["init.templateDir", input.paths.gitTemplateRoot],
    ["filter.lfs.smudge", ""],
    ["filter.lfs.required", "false"],
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", input.allowLocalProtocol ? "always" : "never"],
  ];
  if (input.githubToken) {
    const credential = Buffer.from(`x-access-token:${input.githubToken}`, "utf8").toString("base64");
    configs.push([
      "http.https://github.com/.extraHeader",
      `AUTHORIZATION: basic ${credential}`,
    ]);
  }
  const env: Record<string, string> = {
    ...inheritedExecutableEnvironment(input.sourceEnv ?? process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_COUNT: String(configs.length),
  };
  configs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function runGit(input: {
  paths: KnowledgeRepositoryPaths;
  args: string[];
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
  githubToken?: string;
  allowLocalProtocol?: boolean;
  maxBuffer?: number;
  errorCode?: KnowledgeGitError["code"];
  errorMessage: string;
}): Promise<Buffer> {
  try {
    const result = await (input.runner ?? defaultRunner)({
      args: input.args,
      env: gitEnvironment({
        paths: input.paths,
        sourceEnv: input.sourceEnv,
        githubToken: input.githubToken,
        allowLocalProtocol: input.allowLocalProtocol,
      }),
      maxBuffer: input.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    });
    return result.stdout;
  } catch (error) {
    // Never persist or expose Git stderr, command configuration, or credentials.
    const sanitized = redactText(input.errorMessage, input.githubToken ? [input.githubToken] : []);
    throw new KnowledgeGitError(
      input.errorCode ?? "git-failed",
      sanitized ?? "knowledge Git operation failed",
    );
  }
}

async function githubToken(
  providerStore: ProviderConnectionStore | undefined,
): Promise<string | undefined> {
  if (!providerStore) return undefined;
  try {
    const connection = await providerStore.getConnection("github");
    const token = await connection.getAccessToken();
    return token.trim() || undefined;
  } catch (error) {
    if (error instanceof MissingConnectionError) return undefined;
    throw new KnowledgeGitError("source-unavailable", "GitHub credential could not be resolved");
  }
}

export async function resolveLocalKnowledgeGitRoot(input: {
  path: string;
  paths: KnowledgeRepositoryPaths;
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
}): Promise<string> {
  const candidate = await realpath(resolve(input.path));
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new KnowledgeGitError("invalid-source", "local knowledge source must be a directory");
  }
  const output = await runGit({
    paths: input.paths,
    runner: input.runner,
    sourceEnv: input.sourceEnv,
    allowLocalProtocol: true,
    args: ["-C", candidate, "rev-parse", "--show-toplevel"],
    errorCode: "invalid-source",
    errorMessage: "local knowledge source must be a committed Git repository",
  });
  const rootText = output.toString("utf8").trim();
  if (!rootText) {
    throw new KnowledgeGitError("invalid-source", "local knowledge source Git root is unavailable");
  }
  const root = await realpath(rootText);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    throw new KnowledgeGitError("invalid-source", "local knowledge source Git root is unavailable");
  }
  return root;
}

function fetchRefspec(ref: KnowledgeRepositoryRef): string {
  if (ref.type === "branch") {
    return `+refs/heads/${ref.value}:refs/nitely/source`;
  }
  if (ref.type === "tag") {
    return `+refs/tags/${ref.value}:refs/nitely/source`;
  }
  return `+${ref.value}:refs/nitely/source`;
}

async function initializeBareMirror(input: {
  paths: KnowledgeRepositoryPaths;
  mirrorPath: string;
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
}): Promise<void> {
  try {
    const stats = await lstat(input.mirrorPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new KnowledgeGitError("invalid-source", "knowledge mirror path is unsafe");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  requireManagedKnowledgePath(input.paths, input.mirrorPath);
  await mkdir(dirname(input.mirrorPath), { recursive: true, mode: 0o700 });
  await runGit({
    paths: input.paths,
    runner: input.runner,
    sourceEnv: input.sourceEnv,
    args: ["init", "--bare", input.mirrorPath],
    errorMessage: "knowledge bare mirror initialization failed",
  });
  await chmod(input.mirrorPath, 0o700);
}

export async function refreshKnowledgeGitSnapshot(input: {
  paths: KnowledgeRepositoryPaths;
  source: KnowledgeRepositorySource;
  ref: KnowledgeRepositoryRef;
  providerStore?: ProviderConnectionStore;
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
}): Promise<KnowledgeGitSnapshot> {
  const ref = normalizeKnowledgeGitRef(input.ref);
  let source: KnowledgeRepositorySource;
  if (input.source.type === "local") {
    source = {
      type: "local",
      path: await resolveLocalKnowledgeGitRoot({
        path: input.source.path,
        paths: input.paths,
        runner: input.runner,
        sourceEnv: input.sourceEnv,
      }),
    };
  } else {
    source = {
      type: "remote",
      providerId: "github",
      url: normalizeGitHubKnowledgeUrl(input.source.url),
    };
  }
  const mirrorPath = requireManagedKnowledgePath(
    input.paths,
    knowledgeMirrorPath(input.paths, source),
  );
  const token = source.type === "remote"
    ? await githubToken(input.providerStore)
    : undefined;

  return await withKnowledgeLease(
    { path: `${mirrorPath}.lock`, waitMs: 30_000 },
    async () => {
      await initializeBareMirror({
        paths: input.paths,
        mirrorPath,
        runner: input.runner,
        sourceEnv: input.sourceEnv,
      });
      const sourceLocator = source.type === "local" ? source.path : source.url;
      await runGit({
        paths: input.paths,
        runner: input.runner,
        sourceEnv: input.sourceEnv,
        githubToken: token,
        allowLocalProtocol: source.type === "local",
        args: [
          `--git-dir=${mirrorPath}`,
          "fetch",
          "--force",
          "--no-tags",
          "--depth=1",
          sourceLocator,
          fetchRefspec(ref),
        ],
        errorCode: "source-unavailable",
        errorMessage: "knowledge source or explicit ref is unavailable",
      });
      const commitOutput = await runGit({
        paths: input.paths,
        runner: input.runner,
        sourceEnv: input.sourceEnv,
        args: [`--git-dir=${mirrorPath}`, "rev-parse", "--verify", "refs/nitely/source^{commit}"],
        errorCode: "invalid-ref",
        errorMessage: "knowledge ref did not resolve to a commit",
      });
      const commitSha = commitOutput.toString("utf8").trim().toLowerCase();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) {
        throw new KnowledgeGitError("invalid-ref", "knowledge ref returned an invalid commit id");
      }
      const type = (
        await runGit({
          paths: input.paths,
          runner: input.runner,
          sourceEnv: input.sourceEnv,
          args: [`--git-dir=${mirrorPath}`, "cat-file", "-t", commitSha],
          errorCode: "invalid-ref",
          errorMessage: "knowledge ref did not resolve to a commit",
        })
      ).toString("utf8").trim();
      if (type !== "commit") {
        throw new KnowledgeGitError("invalid-ref", "knowledge ref did not resolve to a commit");
      }
      return { mirrorPath, commitSha, source, ref };
    },
  );
}

function safeTreePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === "..");
}

export async function listKnowledgeGitTree(input: {
  paths: KnowledgeRepositoryPaths;
  mirrorPath: string;
  commitSha: string;
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
  maxEntries?: number;
}): Promise<{ entries: KnowledgeGitTreeEntry[]; skipped: number }> {
  requireManagedKnowledgePath(input.paths, input.mirrorPath);
  const output = await runGit({
    paths: input.paths,
    runner: input.runner,
    sourceEnv: input.sourceEnv,
    args: [
      `--git-dir=${input.mirrorPath}`,
      "ls-tree",
      "-rlz",
      "--full-tree",
      input.commitSha,
    ],
    maxBuffer: 64 * 1024 * 1024,
    errorMessage: "knowledge Git tree could not be read",
  });
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const maximum = input.maxEntries ?? 100_000;
  if (records.length > maximum) {
    throw new KnowledgeGitError("unsafe-tree", "knowledge Git tree exceeds the file-count limit");
  }
  const entries: KnowledgeGitTreeEntry[] = [];
  let skipped = 0;
  const normalizedPaths = new Set<string>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    const metadata = tab >= 0 ? record.slice(0, tab) : "";
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    const [mode, type, objectId, sizeText] = metadata.split(/\s+/);
    if (!safeTreePath(path)) {
      throw new KnowledgeGitError("unsafe-tree", "knowledge Git tree contains an unsafe path");
    }
    const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (normalizedPaths.has(collisionKey)) {
      throw new KnowledgeGitError("unsafe-tree", "knowledge Git tree contains colliding paths");
    }
    normalizedPaths.add(collisionKey);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
      skipped += 1;
      continue;
    }
    const size = Number(sizeText);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(objectId ?? "") || !Number.isSafeInteger(size) || size < 0) {
      throw new KnowledgeGitError("unsafe-tree", "knowledge Git tree contains invalid blob metadata");
    }
    entries.push({
      mode,
      objectId: objectId!.toLowerCase(),
      size,
      path,
    });
  }
  return { entries, skipped };
}

export async function readKnowledgeGitBlob(input: {
  paths: KnowledgeRepositoryPaths;
  mirrorPath: string;
  objectId: string;
  expectedSize: number;
  maximumBytes: number;
  runner?: KnowledgeGitCommandRunner;
  sourceEnv?: Record<string, string | undefined>;
}): Promise<Buffer> {
  requireManagedKnowledgePath(input.paths, input.mirrorPath);
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.objectId) ||
    !Number.isSafeInteger(input.expectedSize) ||
    input.expectedSize < 0 ||
    input.expectedSize > input.maximumBytes
  ) {
    throw new KnowledgeGitError("unsafe-tree", "knowledge blob exceeds the read limit");
  }
  const output = await runGit({
    paths: input.paths,
    runner: input.runner,
    sourceEnv: input.sourceEnv,
    args: [`--git-dir=${input.mirrorPath}`, "cat-file", "blob", input.objectId],
    maxBuffer: input.maximumBytes + 1,
    errorMessage: "knowledge Git blob could not be read",
  });
  if (output.byteLength !== input.expectedSize || output.byteLength > input.maximumBytes) {
    throw new KnowledgeGitError("unsafe-tree", "knowledge Git blob size changed unexpectedly");
  }
  return output;
}
