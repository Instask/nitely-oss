import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type PreviewSessionStatus =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "timed_out"
  | "stale";

export interface PreviewActor {
  id: string;
  email?: string;
}

export interface PreviewViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  preset?: string;
}

export interface PreviewViewportPreset extends PreviewViewport {
  id: string;
  label: string;
}

export const PREVIEW_VIEWPORT_PRESETS: Record<string, PreviewViewportPreset> = {
  desktop: {
    id: "desktop",
    preset: "desktop",
    label: "Desktop",
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
  },
  tablet: {
    id: "tablet",
    preset: "tablet",
    label: "Tablet",
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
  },
  mobile: {
    id: "mobile",
    preset: "mobile",
    label: "Mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
  },
};

export type PreviewActionCapability =
  | "navigate"
  | "reload"
  | "screenshot"
  | "diagnostics"
  | "hierarchy"
  | "click"
  | "type"
  | "scroll";

export interface PreviewProviderCapabilities {
  provider: string;
  actions: PreviewActionCapability[];
  screenshots: {
    viewport: boolean;
    fullPage: boolean;
    formats: Array<"png">;
  };
  diagnostics: {
    console: boolean;
    pageErrors: boolean;
    failedRequests: boolean;
  };
  hierarchy: {
    dom: boolean;
    layoutBoxes: boolean;
    computedStyle: boolean;
  };
}

export interface PreviewCommandReadiness {
  url?: string;
  path?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface PreviewCommandConfig {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: string[];
  targetUrl?: string;
  allowedRoutes?: string[];
  readiness?: PreviewCommandReadiness;
}

export interface PreviewRepositoryConfig {
  schemaVersion: "nitely.preview.v1";
  commands: PreviewCommandConfig[];
}

export interface PreviewServerProcessState {
  pid?: number;
  command: string;
  args: string[];
  cwd: string;
  readinessUrl: string;
  stdoutTail: string;
  stderrTail: string;
  exitCode?: number | null;
  signal?: string | null;
}

export interface PreviewDiagnosticEvent {
  type: "console" | "pageerror" | "requestfailed" | "server";
  at: string;
  level?: string;
  message: string;
  url?: string;
}

export interface PreviewDiagnostics {
  sessionId: string;
  collectedAt: string;
  console: PreviewDiagnosticEvent[];
  pageErrors: PreviewDiagnosticEvent[];
  failedRequests: PreviewDiagnosticEvent[];
  server: {
    stdoutTail: string;
    stderrTail: string;
    exitCode?: number | null;
    signal?: string | null;
  };
}

export interface PreviewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewHierarchyNode {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  role?: string;
  name?: string;
  box?: PreviewBox;
  computedStyle?: Record<string, string>;
  children?: PreviewHierarchyNode[];
}

export interface PreviewScreenshotArtifact {
  id: string;
  path: string;
  mediaType: "image/png";
  sha256: string;
  size: number;
  fullPage: boolean;
  viewport: PreviewViewport;
  url?: string;
  capturedAt: string;
}

export interface PreviewSessionRecord {
  schemaVersion: "nitely.preview-session.v1";
  id: string;
  repoId: string;
  repoPath: string;
  commandId: string;
  workItemId?: string;
  runId?: string;
  status: PreviewSessionStatus;
  actor: PreviewActor;
  ownerId?: string;
  organizationId?: string;
  provider: string;
  capabilities: PreviewProviderCapabilities;
  viewport: PreviewViewport;
  targetUrl: string;
  allowedRoutes?: string[];
  currentUrl?: string;
  route?: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  stoppedAt?: string;
  failedAt?: string;
  timedOutAt?: string;
  staleAt?: string;
  failure?: string;
  server: PreviewServerProcessState;
  diagnostics: PreviewDiagnostics;
  screenshots: PreviewScreenshotArtifact[];
}

export interface PreviewStartInput {
  repoId: string;
  repoPath: string;
  commandId: string;
  actor: PreviewActor;
  ownerId?: string;
  organizationId?: string;
  workItemId?: string;
  runId?: string;
  route?: string;
  targetUrl?: string;
  viewport?: PreviewViewport;
}

export interface PreviewRuntimeStartInput {
  sessionId: string;
  targetUrl: string;
  viewport: PreviewViewport;
}

export interface PreviewRuntimeSession {
  provider: string;
  capabilities: PreviewProviderCapabilities;
  currentUrl(): Promise<string | undefined>;
  navigate(url: string): Promise<string | undefined>;
  reload(): Promise<string | undefined>;
  screenshot(input: { fullPage: boolean }): Promise<Buffer>;
  diagnostics(): Promise<{
    console: PreviewDiagnosticEvent[];
    pageErrors: PreviewDiagnosticEvent[];
    failedRequests: PreviewDiagnosticEvent[];
  }>;
  hierarchy(): Promise<PreviewHierarchyNode>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(input: { deltaX?: number; deltaY?: number }): Promise<void>;
  close(): Promise<void>;
}

export interface PreviewRuntimeProvider {
  provider: string;
  capabilities: PreviewProviderCapabilities;
  start(input: PreviewRuntimeStartInput): Promise<PreviewRuntimeSession>;
}

export interface ActivePreviewSession {
  record: PreviewSessionRecord;
  process: ChildProcessWithoutNullStreams;
  runtime?: PreviewRuntimeSession;
  redactionSecrets: string[];
}
