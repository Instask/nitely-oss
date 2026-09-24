import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * OCI network allowlist gateway (#477).
 *
 * Default OCI networking remains deny-all (`--network=none`). When operators
 * configure an allowlist, this module can start an HTTP CONNECT proxy that only
 * dials allowed hostnames, and emit Docker args so the workload reaches that
 * proxy via `host.docker.internal`.
 *
 * Enforcement model (fail-closed where we cannot guarantee more):
 * - CONNECT to non-allowlisted hosts is rejected by the gateway.
 * - The workload joins an internal-only Docker network with no direct egress.
 * - Docker bridge is never a workload network; missing topology fails closed.
 * - Container receives HTTPS_PROXY/HTTP_PROXY/ALL_PROXY pointing at the gateway
 *   so approved CLIs can reach it; those variables are not the boundary.
 * - Open unrestricted Docker networking is never enabled without a gateway.
 * - Capability network mode `allowed` remains unsupported.
 */

export type OciNetworkMode = "none" | "allowlist";

export interface OciNetworkPolicy {
  mode: OciNetworkMode;
  /** Sorted unique lowercase domains (empty when mode is none). */
  domains: readonly string[];
  /** Evidence id: none | http-connect-allowlist */
  gatewayId: string;
}

export interface ContainerNetworkPlan {
  /** Args spliced into `docker run` (includes --network). */
  dockerArgs: string[];
  /** Extra container env pairs (name=value). */
  containerEnv: Record<string, string>;
  /** Secret-free summary for evidence / describeExecution. */
  description: string;
}

export interface NetworkAllowlistGateway {
  readonly id: string;
  readonly domains: readonly string[];
  /** True when the workload must use the provisioned internal-only network. */
  readonly requiresInternalNetwork?: boolean;
  assertEnforceable(): Promise<void>;
  prepareContainerNetwork(): Promise<ContainerNetworkPlan>;
  dispose(): Promise<void>;
}

export interface GatewayProcessInput {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GatewayProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const DOMAIN_PATTERN = new RegExp(
  `^(?:\\*\\.)?(?:${LABEL})(?:\\.(?:${LABEL}))*$`,
);

export function normalizeAllowlistDomain(raw: string): string {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes("..") ||
    !DOMAIN_PATTERN.test(domain)
  ) {
    throw new Error(`invalid OCI network allowlist domain: ${raw}`);
  }
  return domain;
}

export function parseNetworkAllowlist(
  raw: string | undefined,
): readonly string[] {
  if (!raw?.trim()) return [];
  const domains = [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(normalizeAllowlistDomain),
    ),
  ].sort();
  return domains;
}

export function parseOciNetworkPolicy(input: {
  allowlistRaw?: string;
  gatewayId?: string;
}): OciNetworkPolicy {
  const domains = parseNetworkAllowlist(input.allowlistRaw);
  if (domains.length === 0) {
    return { mode: "none", domains: [], gatewayId: "none" };
  }
  return {
    mode: "allowlist",
    domains,
    gatewayId: input.gatewayId?.trim() || "http-connect-allowlist",
  };
}

/** Exact host or `*.example.com` suffix match (also matches apex example.com). */
export function hostMatchesAllowlist(
  host: string,
  allowlist: readonly string[],
): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  // Strip brackets from IPv6 literals — never allow bare IPs via domain list.
  if (net.isIP(normalized)) return false;
  for (const entry of allowlist) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      const apex = entry.slice(2);
      if (normalized === apex || normalized.endsWith(suffix)) {
        return true;
      }
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

export function formatNetworkPolicyDescription(policy: OciNetworkPolicy): string {
  if (policy.mode === "none") return "none";
  return `allowlist(${policy.domains.join(",")}) via ${policy.gatewayId}`;
}

export interface HttpConnectAllowlistGatewayOptions {
  domains: readonly string[];
  /** Host alias injected into the container (default host.docker.internal). */
  hostAlias?: string;
  /** Bind address for the proxy (default 127.0.0.1). */
  bindHost?: string;
  /** Optional fixed port (default ephemeral). */
  port?: number;
  /** Provisioned Docker network used to block direct workload egress. */
  networkName?: string;
  /** Host address of the provisioned Docker network gateway. */
  hostGatewayAddress?: string;
  /** Injected for tests. */
  createServer?: typeof http.createServer;
}

/**
 * Host-side HTTP CONNECT proxy that only dials allowlisted hostnames.
 * Workload containers still need an internal-only Docker network; proxy env
 * is how approved CLIs reach this gateway, not the egress boundary.
 */
export class HttpConnectAllowlistGateway implements NetworkAllowlistGateway {
  readonly id = "http-connect-allowlist";
  readonly requiresInternalNetwork = true;
  readonly domains: readonly string[];
  private readonly hostAlias: string;
  private readonly bindHost: string;
  private readonly preferredPort?: number;
  private readonly networkName?: string;
  private readonly hostGatewayAddress?: string;
  private readonly createServer: typeof http.createServer;
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(options: HttpConnectAllowlistGatewayOptions) {
    if (options.domains.length === 0) {
      throw new Error(
        "HTTP CONNECT network gateway requires a non-empty domain allowlist",
      );
    }
    this.domains = [...options.domains];
    this.hostAlias = options.hostAlias?.trim() || "host.docker.internal";
    this.bindHost = options.bindHost?.trim() || "127.0.0.1";
    this.preferredPort = options.port;
    this.networkName = options.networkName;
    this.hostGatewayAddress = options.hostGatewayAddress;
    this.createServer = options.createServer ?? http.createServer;
  }

  async assertEnforceable(): Promise<void> {
    await this.ensureListening();
  }

  async prepareContainerNetwork(): Promise<ContainerNetworkPlan> {
    await this.ensureListening();
    const port = this.port;
    if (port === undefined) {
      throw new Error("network allowlist gateway failed to bind a local port");
    }
    if (!this.networkName) {
      throw new Error(
        "HTTP CONNECT network gateway requires an internal-only workload network; docker bridge is not an enforceable egress boundary",
      );
    }
    const proxyUrl = `http://${this.hostAlias}:${port}`;
    return {
      dockerArgs: [
        `--network=${this.networkName}`,
        "--add-host",
        `${this.hostAlias}:${this.hostGatewayAddress ?? "host-gateway"}`,
      ],
      containerEnv: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        // Force proxy for all hosts; do not punch holes.
        NO_PROXY: "",
        no_proxy: "",
      },
      description: formatNetworkPolicyDescription({
        mode: "allowlist",
        domains: this.domains,
        gatewayId: this.id,
      }),
    };
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
  }

  private async ensureListening(): Promise<void> {
    if (this.server && this.port !== undefined) return;
    const server = this.createServer();
    server.on("request", (req, res) => {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("only CONNECT is supported\n");
    });
    server.on("connect", (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head);
    });

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.preferredPort ?? 0, this.bindHost);
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      server.close();
      throw new Error("network allowlist gateway failed to determine listen port");
    }
    this.server = server;
    this.port = address.port;
  }

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const authority = req.url ?? "";
    const [hostPart, portPart] = splitAuthority(authority);
    const port = Number(portPart || "443");
    if (!hostPart || !Number.isInteger(port) || port <= 0 || port > 65535) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    if (!hostMatchesAllowlist(hostPart, this.domains)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(port, hostPart, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      upstream.destroy();
    });
  }
}

/**
 * Sidecar proxy source, run with `node -e` inside the gateway container.
 *
 * Exported so a test can run the script itself: the sidecar path needs a
 * container engine, so nothing else here would catch a script that no longer
 * speaks HTTP.
 */
export const CONTAINER_GATEWAY_SCRIPT = String.raw`
const http = require("node:http");
const net = require("node:net");
const allowlist = JSON.parse(process.env.NITELY_GATEWAY_ALLOWLIST || "[]");
const port = Number(process.env.NITELY_GATEWAY_PORT || "18080");
function matches(host) {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || net.isIP(normalized)) return false;
  return allowlist.some((entry) => entry.startsWith("*.")
    ? normalized === entry.slice(2) || normalized.endsWith(entry.slice(1))
    : normalized === entry);
}
function authority(value) {
  const text = value.trim();
  const index = text.lastIndexOf(":");
  return index < 0 ? [text, 443] : [text.slice(0, index), Number(text.slice(index + 1))];
}
const server = http.createServer((_req, res) => {
  res.writeHead(405, { "content-type": "text/plain" });
  res.end("only CONNECT is supported\n");
});
server.on("connect", (req, client, head) => {
  const [host, targetPort] = authority(req.url || "");
  if (!host || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535 || !matches(host)) {
    client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    client.destroy();
    return;
  }
  const upstream = net.connect(targetPort, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => {
    client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    client.destroy();
  });
  client.on("error", () => upstream.destroy());
});
server.listen(port, "0.0.0.0");
`;

export interface ContainerNetworkAllowlistGatewayOptions {
  domains: readonly string[];
  image: string;
  networkName: string;
  containerName: string;
  engineCommand: string;
  engineEnv: Record<string, string | undefined>;
  processRunner: (input: GatewayProcessInput) => Promise<GatewayProcessResult>;
  labels?: Record<string, string>;
}

/**
 * Docker sidecar gateway. The sidecar has the normal external bridge plus the
 * internal workload network; workloads only join the latter.
 */
export class ContainerNetworkAllowlistGateway implements NetworkAllowlistGateway {
  readonly id = "http-connect-allowlist";
  readonly requiresInternalNetwork = true;
  readonly domains: readonly string[];
  private readonly options: ContainerNetworkAllowlistGatewayOptions;
  private started = false;

  constructor(options: ContainerNetworkAllowlistGatewayOptions) {
    if (options.domains.length === 0) {
      throw new Error(
        "container network gateway requires a non-empty domain allowlist",
      );
    }
    this.domains = [...options.domains];
    this.options = options;
  }

  async assertEnforceable(): Promise<void> {
    const { options } = this;
    const started = await options.processRunner({
      command: options.engineCommand,
      args: [
        "run",
        "-d",
        "--rm",
        "--init",
        "--pull=never",
        "--read-only",
        ...Object.entries(options.labels ?? {}).flatMap(([name, value]) => [
          "--label",
          `${name}=${value}`,
        ]),
        "--network=bridge",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--name",
        options.containerName,
        "--env",
        `NITELY_GATEWAY_ALLOWLIST=${JSON.stringify(this.domains)}`,
        "--env",
        "NITELY_GATEWAY_PORT=18080",
        options.image,
        "node",
        "-e",
        CONTAINER_GATEWAY_SCRIPT,
      ],
      env: options.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (started.exitCode !== 0) {
      throw new Error(
        `OCI network gateway could not start: ${
          started.stderr.trim() || `exit ${started.exitCode}`
        }`,
      );
    }
    this.started = true;
    try {
      const connected = await options.processRunner({
        command: options.engineCommand,
        args: [
          "network",
          "connect",
          "--alias",
          options.containerName,
          options.networkName,
          options.containerName,
        ],
        env: options.engineEnv,
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
      });
      if (connected.exitCode !== 0) {
        throw new Error(
          `OCI network gateway could not join the internal network: ${
            connected.stderr.trim() || `exit ${connected.exitCode}`
          }`,
        );
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const probe = await options.processRunner({
          command: options.engineCommand,
          args: [
            "exec",
            options.containerName,
            "node",
            "-e",
            "const net=require('node:net'); const socket=net.connect(18080,'127.0.0.1'); socket.once('connect',()=>{socket.destroy(); process.exit(0)}); socket.once('error',()=>process.exit(1));",
          ],
          env: options.engineEnv,
          timeoutMs: 1_000,
          maxOutputBytes: 1024 * 1024,
        });
        if (probe.exitCode === 0) {
          return;
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      throw new Error("OCI network gateway did not become ready");
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  async prepareContainerNetwork(): Promise<ContainerNetworkPlan> {
    if (!this.started) {
      throw new Error("OCI network gateway is not ready");
    }
    const proxyUrl = `http://${this.options.containerName}:18080`;
    return {
      dockerArgs: [`--network=${this.options.networkName}`],
      containerEnv: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
      },
      description: formatNetworkPolicyDescription({
        mode: "allowlist",
        domains: this.domains,
        gatewayId: this.id,
      }),
    };
  }

  async dispose(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const result = await this.options.processRunner({
      command: this.options.engineCommand,
      args: ["rm", "-f", this.options.containerName],
      env: this.options.engineEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (
      result.exitCode !== 0 &&
      !/no such container/i.test(result.stderr)
    ) {
      throw new Error(
        `OCI network gateway cleanup failed: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`,
      );
    }
  }
}

function splitAuthority(authority: string): [string, string | undefined] {
  const value = authority.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return ["", undefined];
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : undefined;
    return [host, port];
  }
  const index = value.lastIndexOf(":");
  if (index < 0) return [value, undefined];
  return [value.slice(0, index), value.slice(index + 1)];
}

export function createNetworkAllowlistGateway(input: {
  policy: OciNetworkPolicy;
  createServer?: typeof http.createServer;
  bindHost?: string;
  networkName?: string;
  hostGatewayAddress?: string;
}): NetworkAllowlistGateway | undefined {
  if (input.policy.mode !== "allowlist") return undefined;
  if (input.policy.gatewayId !== "http-connect-allowlist") {
    throw new Error(
      `unsupported OCI network gateway: ${input.policy.gatewayId}. Supported: http-connect-allowlist`,
    );
  }
  return new HttpConnectAllowlistGateway({
    domains: input.policy.domains,
    createServer: input.createServer,
    ...(input.bindHost ? { bindHost: input.bindHost } : {}),
    ...(input.networkName ? { networkName: input.networkName } : {}),
    ...(input.hostGatewayAddress
      ? { hostGatewayAddress: input.hostGatewayAddress }
      : {}),
  });
}
