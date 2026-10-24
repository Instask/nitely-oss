/**
 * Checks the tarball Nitely publishes: entrypoints, contracted files, and
 * paths that must never ship. The package-install smoke and its regression
 * fixture both call this, so a broken bin or export fails the same way in CI
 * as it does in the unit test.
 */

export interface PackedPackageManifest {
  name?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
}

export interface PackedFileContent {
  path: string;
  content: Buffer | string;
}

export interface PackedFileMode {
  path: string;
  mode: number;
}

export interface PackedPackageInput {
  paths: readonly string[];
  manifest: PackedPackageManifest;
  /** Bin file text, keyed by package-relative path. Enables the shebang check. */
  binTexts?: readonly { path: string; text: string }[];
  /** File modes from the extracted tarball. Enables the executable-bit check. */
  modes?: readonly PackedFileMode[];
  fileContents?: readonly PackedFileContent[];
}

export interface PackedPackageRegression {
  name: "broken-bin" | "broken-export" | "private-nitely-path";
  planted: string;
  problems: string[];
}

export const REQUIRED_PACKED_FILES = [
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE",
  "dist/index.js",
  "dist/run/execution/command-mediator.py",
  "dist/api.js",
  "dist/api.d.ts",
  "dist/runner-control-plane/protocol.js",
  "dist/runner-control-plane/protocol.d.ts",
  "dist/runner-control-plane/file-stub.js",
  "dist/runner-control-plane/file-stub.d.ts",
  "dist/web/server.js",
  "src/web/static/console.dc.html",
  "src/web/static/device.html",
  "src/web/static/support.js",
  "docs/golden-path-demo.md",
] as const;

/**
 * Directory `dist/web/server.js` reads. The server joins `..`, `..`, and this
 * path onto `import.meta.url`.
 */
export const WEB_STATIC_DIR = "src/web/static";

export const WEB_STATIC_ASSETS = [
  { path: "src/web/static/console.dc.html", marker: "<x-dc>" },
  { path: "src/web/static/device.html", marker: "Authorize a device" },
  { path: "src/web/static/support.js", marker: "dc-runtime" },
] as const;

/** Sentinel paths planted by the regression fixture. They must not be real files. */
export const PACKED_PACKAGE_MISSING_BIN = "dist/package-smoke-missing-bin.js";
export const PACKED_PACKAGE_MISSING_EXPORT = "dist/package-smoke-missing-export.js";
export const PACKED_PACKAGE_PRIVATE_PATH = ".nitely/providers/credentials.json";

const FORBIDDEN_SEGMENTS = new Set([
  ".nitely",
  ".nightly",
  ".worktrees",
  ".git",
  "node_modules",
  ".pnpm-store",
  "worktrees",
]);

const PRIVATE_KEY_MARKERS = [
  `-----BEGIN ${"PRIVATE"} KEY-----`,
  `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
  `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
  `-----BEGIN ${"EC"} PRIVATE KEY-----`,
  `-----BEGIN ${"DSA"} PRIVATE KEY-----`,
  `-----BEGIN ${"PGP"} PRIVATE KEY BLOCK-----`,
];

const GOLDEN_PATH_PROOF_KEYS = [
  "approvedPlanning",
  "eligibleImplementationStart",
  "verifiedImplementation",
  "draftPullRequest",
  "evidenceBacked",
  "controlledSamePullRequestRework",
] as const;

export function packagePathsFromTarList(lines: readonly string[]): string[] {
  const entries = lines
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
  const rooted = entries.filter((entry) => entry.includes("/"));
  const roots = new Set(rooted.map((entry) => entry.slice(0, entry.indexOf("/"))));
  if (roots.size !== 1) return entries;
  const root = [...roots][0];
  return rooted
    .map((entry) => entry.slice(root.length + 1))
    .filter((entry) => entry.length > 0);
}

export function inspectPackedPackage(input: PackedPackageInput): string[] {
  const problems: string[] = [];
  const paths = new Set(input.paths.map(normalizePackedPath));

  for (const required of REQUIRED_PACKED_FILES) {
    if (!paths.has(required)) problems.push(`missing packed file: ${required}`);
  }
  if (![...paths].some((path) => /^flows\/[^/]+\.json$/.test(path))) {
    problems.push("missing packed flow under flows/");
  }

  for (const path of input.paths) {
    const reason = forbiddenPackedPath(path);
    if (reason) problems.push(`forbidden packed path ${normalizePackedPath(path)} (${reason})`);
  }

  const bins = collectBins(input.manifest, problems);
  for (const bin of bins) {
    if (!paths.has(bin.path)) {
      problems.push(`bin ${bin.name} points at missing file ${bin.path}`);
    }
  }

  for (const target of collectExportTargets(input.manifest.exports, problems)) {
    if (!paths.has(target.path)) {
      problems.push(
        `export ${target.subpath} ${target.condition} points at missing file ${target.path}`,
      );
    }
  }

  if (input.binTexts) {
    const texts = new Map(input.binTexts.map((entry) => [normalizePackedPath(entry.path), entry.text]));
    for (const bin of bins) {
      const text = texts.get(bin.path);
      if (text === undefined) {
        problems.push(`bin ${bin.name} has no file text to check`);
        continue;
      }
      if (!text.startsWith("#!")) problems.push(`bin ${bin.name} is missing a shebang`);
    }
  }

  if (input.modes) {
    const modes = new Map(input.modes.map((entry) => [normalizePackedPath(entry.path), entry.mode]));
    for (const bin of bins) {
      const mode = modes.get(bin.path);
      if (mode === undefined) {
        problems.push(`bin ${bin.name} has no file mode to check`);
        continue;
      }
      if ((mode & 0o100) === 0) problems.push(`bin ${bin.name} is not executable`);
    }
  }

  for (const file of input.fileContents ?? []) {
    const problem = privateKeyProblem(file.path, file.content);
    if (problem) problems.push(problem);
  }

  return problems;
}

/**
 * Proves the inspector rejects a broken bin, a broken export, and a private
 * `.nitely` path. Each result must mention `planted`. The package-install
 * smoke runs this against the real tarball listing.
 */
export function packedPackageRegressionProblems(
  input: PackedPackageInput,
): PackedPackageRegression[] {
  const brokenBin = inspectPackedPackage({
    paths: input.paths,
    manifest: { ...input.manifest, bin: { nitely: `./${PACKED_PACKAGE_MISSING_BIN}` } },
  });
  const brokenExport = inspectPackedPackage({
    paths: input.paths,
    manifest: withBrokenDefaultExport(input.manifest),
  });
  const privatePath = inspectPackedPackage({
    paths: [...input.paths, PACKED_PACKAGE_PRIVATE_PATH],
    manifest: input.manifest,
  });
  return [
    {
      name: "broken-bin",
      planted: PACKED_PACKAGE_MISSING_BIN,
      problems: brokenBin,
    },
    {
      name: "broken-export",
      planted: PACKED_PACKAGE_MISSING_EXPORT,
      problems: brokenExport,
    },
    {
      name: "private-nitely-path",
      planted: PACKED_PACKAGE_PRIVATE_PATH,
      problems: privatePath,
    },
  ];
}

export function webStaticProblems(
  files: readonly { path: string; text: string }[],
): string[] {
  const problems: string[] = [];
  for (const asset of WEB_STATIC_ASSETS) {
    const file = files.find((candidate) => normalizePackedPath(candidate.path) === asset.path);
    if (!file) {
      problems.push(`missing web static asset ${asset.path}`);
      continue;
    }
    if (!file.text.includes(asset.marker)) {
      problems.push(`web static asset ${asset.path} is missing ${JSON.stringify(asset.marker)}`);
    }
  }
  return problems;
}

export function privateKeyProblem(path: string, content: Buffer | string): string | undefined {
  const text = typeof content === "string" ? content : content.toString("latin1");
  for (const marker of PRIVATE_KEY_MARKERS) {
    if (text.includes(marker)) return `packed file ${normalizePackedPath(path)} contains a private key`;
  }
  return undefined;
}

export function goldenPathProofProblems(summary: unknown): string[] {
  if (typeof summary !== "object" || summary === null) {
    return ["golden path summary is missing"];
  }
  const proof = (summary as { proof?: unknown }).proof;
  if (typeof proof !== "object" || proof === null) return ["golden path proof is missing"];
  const record = proof as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of GOLDEN_PATH_PROOF_KEYS) {
    if (record[key] !== true) problems.push(`golden path proof ${key} is not true`);
  }
  return problems;
}

export function redactDiagnosticText(text: string): string {
  return text
    .replaceAll("golden-path-demo-token", "[redacted]")
    .replaceAll(/ghp_[A-Za-z0-9_]+/g, "[redacted]")
    .replaceAll(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replaceAll(/\bsk-[A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]");
}

function withBrokenDefaultExport(manifest: PackedPackageManifest): PackedPackageManifest {
  const exportsValue = structuredClone(manifest.exports);
  const planted = `./${PACKED_PACKAGE_MISSING_EXPORT}`;
  if (typeof exportsValue !== "object" || exportsValue === null || Array.isArray(exportsValue)) {
    return { ...manifest, exports: { ".": { default: planted } } };
  }
  const record = exportsValue as Record<string, unknown>;
  const dot = record["."];
  if (typeof dot !== "object" || dot === null || Array.isArray(dot)) {
    record["."] = { default: planted };
  } else {
    (dot as Record<string, unknown>).default = planted;
  }
  return { ...manifest, exports: record };
}

function collectBins(
  manifest: PackedPackageManifest,
  problems: string[],
): { name: string; path: string }[] {
  const name = manifest.name || "nitely";
  const bin = manifest.bin;
  if (typeof bin === "string") {
    const path = relativePackedPath(bin, `bin ${name}`, problems);
    return path ? [{ name, path }] : [];
  }
  if (typeof bin !== "object" || bin === null) {
    problems.push("package bin is missing");
    return [];
  }
  const entries = Object.entries(bin);
  if (entries.length === 0) {
    problems.push("package bin is missing");
    return [];
  }
  const bins: { name: string; path: string }[] = [];
  for (const [binName, target] of entries) {
    if (typeof target !== "string") {
      problems.push(`bin ${binName} is not a file`);
      continue;
    }
    const path = relativePackedPath(target, `bin ${binName}`, problems);
    if (path) bins.push({ name: binName, path });
  }
  return bins;
}

interface ExportTarget {
  subpath: string;
  condition: string;
  path: string;
}

function collectExportTargets(exportsValue: unknown, problems: string[]): ExportTarget[] {
  if (exportsValue == null) {
    problems.push("package exports is missing");
    return [];
  }
  const targets: ExportTarget[] = [];
  walkExports(exportsValue, ".", "default", targets, problems);
  if (targets.length === 0 && !problems.some((problem) => problem.startsWith("export "))) {
    problems.push("package exports is missing");
  }
  return targets;
}

function walkExports(
  value: unknown,
  subpath: string,
  condition: string,
  targets: ExportTarget[],
  problems: string[],
): void {
  if (typeof value === "string") {
    const path = relativePackedPath(value, `export ${subpath} ${condition}`, problems);
    if (path) targets.push({ subpath, condition, path });
    return;
  }
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkExports(entry, subpath, `${condition}[${index}]`, targets, problems),
    );
    return;
  }
  if (typeof value !== "object") {
    problems.push(`export ${subpath} ${condition} is not a file`);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    problems.push(`export ${subpath} is empty`);
    return;
  }
  for (const [key, nested] of entries) {
    if (key.startsWith(".")) walkExports(nested, key, "default", targets, problems);
    else walkExports(nested, subpath, key, targets, problems);
  }
}

function relativePackedPath(specifier: string, label: string, problems: string[]): string | undefined {
  if (!specifier.startsWith("./") || specifier.includes("\\") || specifier.split("/").includes("..")) {
    problems.push(`${label} is not a relative file`);
    return undefined;
  }
  return specifier.slice(2);
}

function forbiddenPackedPath(path: string): string | undefined {
  const normalized = normalizePackedPath(path);
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return segment;
    if (segment === ".env" || segment.startsWith(".env.")) return "env file";
  }
  const base = segments.at(-1) ?? "";
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.test(base)) return "private key filename";
  if (/\.(pem|p12|pfx)$/i.test(base)) return "certificate or key material";
  if (base === "credentials.json" || base === "secrets.json") return "credentials file";
  return undefined;
}

function normalizePackedPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replaceAll("\\", "/");
}
