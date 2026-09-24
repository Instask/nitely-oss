import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTAINER_GATEWAY_SCRIPT,
  ContainerNetworkAllowlistGateway,
  HttpConnectAllowlistGateway,
  createNetworkAllowlistGateway,
  formatNetworkPolicyDescription,
  hostMatchesAllowlist,
  normalizeAllowlistDomain,
  parseNetworkAllowlist,
  parseOciNetworkPolicy,
} from "../../../src/run/execution/network-gateway.js";

const gateways: HttpConnectAllowlistGateway[] = [];

afterEach(async () => {
  while (gateways.length > 0) {
    const gateway = gateways.pop();
    await gateway?.dispose();
  }
});

describe("parseNetworkAllowlist", () => {
  it("returns empty list for missing or blank input", () => {
    expect(parseNetworkAllowlist(undefined)).toEqual([]);
    expect(parseNetworkAllowlist("  ")).toEqual([]);
  });

  it("normalizes, dedupes, and sorts domains", () => {
    expect(
      parseNetworkAllowlist("API.OpenAI.com., *.anthropic.com, api.openai.com"),
    ).toEqual(["*.anthropic.com", "api.openai.com"]);
  });

  it("rejects invalid domain tokens fail-closed", () => {
    expect(() => parseNetworkAllowlist("not a domain")).toThrow(
      /invalid OCI network allowlist domain/i,
    );
    expect(() => normalizeAllowlistDomain("-bad.com")).toThrow(
      /invalid OCI network allowlist domain/i,
    );
  });
});

describe("hostMatchesAllowlist", () => {
  const allowlist = ["api.openai.com", "*.anthropic.com"];

  it("matches exact hosts case-insensitively", () => {
    expect(hostMatchesAllowlist("API.OpenAI.com", allowlist)).toBe(true);
    expect(hostMatchesAllowlist("api.openai.com.", allowlist)).toBe(true);
  });

  it("matches wildcard suffixes and apex", () => {
    expect(hostMatchesAllowlist("api.anthropic.com", allowlist)).toBe(true);
    expect(hostMatchesAllowlist("anthropic.com", allowlist)).toBe(true);
    expect(hostMatchesAllowlist("evilanthropic.com", allowlist)).toBe(false);
  });

  it("never matches bare IP literals", () => {
    expect(hostMatchesAllowlist("1.2.3.4", ["1.2.3.4"])).toBe(false);
    expect(hostMatchesAllowlist("::1", ["::1"])).toBe(false);
  });
});

describe("parseOciNetworkPolicy", () => {
  it("defaults to deny-all none mode", () => {
    expect(parseOciNetworkPolicy({})).toEqual({
      mode: "none",
      domains: [],
      gatewayId: "none",
    });
  });

  it("enables allowlist mode when domains are configured", () => {
    expect(
      parseOciNetworkPolicy({
        allowlistRaw: "api.openai.com",
      }),
    ).toEqual({
      mode: "allowlist",
      domains: ["api.openai.com"],
      gatewayId: "http-connect-allowlist",
    });
  });

  it("formats secret-free descriptions", () => {
    expect(
      formatNetworkPolicyDescription({
        mode: "allowlist",
        domains: ["api.openai.com"],
        gatewayId: "http-connect-allowlist",
      }),
    ).toBe("allowlist(api.openai.com) via http-connect-allowlist");
  });
});

describe("HttpConnectAllowlistGateway", () => {
  it("fails closed when domain list is empty", () => {
    expect(() => new HttpConnectAllowlistGateway({ domains: [] })).toThrow(
      /non-empty domain allowlist/i,
    );
  });

  it("fails closed instead of attaching the workload to docker bridge", async () => {
    const gateway = new HttpConnectAllowlistGateway({
      domains: ["api.openai.com"],
    });
    gateways.push(gateway);
    await gateway.assertEnforceable();
    await expect(gateway.prepareContainerNetwork()).rejects.toThrow(
      /internal-only workload network/i,
    );
  });

  it("prepares proxy env without secret values once an internal network is provided", async () => {
    const gateway = new HttpConnectAllowlistGateway({
      domains: ["api.openai.com"],
      networkName: "nitely-egress-secret-check",
    });
    gateways.push(gateway);
    await gateway.assertEnforceable();
    const plan = await gateway.prepareContainerNetwork();
    expect(plan.dockerArgs).toEqual([
      "--network=nitely-egress-secret-check",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    expect(plan.containerEnv.HTTPS_PROXY).toMatch(
      /^http:\/\/host\.docker\.internal:\d+$/,
    );
    expect(plan.containerEnv.NO_PROXY).toBe("");
    expect(plan.description).toContain("allowlist(api.openai.com)");
    expect(plan.description).not.toMatch(/sk-|secret|token/i);
  });

  it("targets a provisioned internal network and its host gateway", async () => {
    const gateway = new HttpConnectAllowlistGateway({
      domains: ["api.openai.com"],
      networkName: "nitely-egress-test",
      hostGatewayAddress: "172.30.0.1",
      bindHost: "127.0.0.1",
    });
    gateways.push(gateway);
    await gateway.assertEnforceable();
    const plan = await gateway.prepareContainerNetwork();
    expect(plan.dockerArgs).toEqual([
      "--network=nitely-egress-test",
      "--add-host",
      "host.docker.internal:172.30.0.1",
    ]);
    expect(gateway.requiresInternalNetwork).toBe(true);
  });

  it("starts a sidecar on the external bridge and internal workload network", async () => {
    const calls: string[][] = [];
    const gateway = new ContainerNetworkAllowlistGateway({
      domains: ["api.openai.com"],
      image: "nitely-runner:test",
      networkName: "nitely-egress-test",
      containerName: "nitely-egress-gateway-test",
      engineCommand: "docker",
      engineEnv: {},
      labels: {
        "com.nitely.managed": "true",
        "com.nitely.expires-at": "2026-09-18T00:00:30.000Z",
      },
      processRunner: async (input) => {
        calls.push(input.args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await gateway.assertEnforceable();
    const plan = await gateway.prepareContainerNetwork();
    await gateway.dispose();

    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--label",
        "com.nitely.managed=true",
        "--label",
        "com.nitely.expires-at=2026-09-18T00:00:30.000Z",
        "--network=bridge",
        "nitely-runner:test",
      ]),
    );
    expect(calls[1]).toEqual([
      "network",
      "connect",
      "--alias",
      "nitely-egress-gateway-test",
      "nitely-egress-test",
      "nitely-egress-gateway-test",
    ]);
    expect(calls.some((args) => args[0] === "exec")).toBe(true);
    expect(plan.dockerArgs).toEqual(["--network=nitely-egress-test"]);
    expect(plan.containerEnv.HTTPS_PROXY).toBe(
      "http://nitely-egress-gateway-test:18080",
    );
    expect(calls.at(-1)).toEqual([
      "rm",
      "-f",
      "nitely-egress-gateway-test",
    ]);
  });

  it("allows CONNECT to allowlisted hosts and denies others", async () => {
    const upstream = net.createServer((socket) => {
      socket.write("hello");
      socket.end();
    });
    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    // Loopback alias so the proxy dials our local upstream by hostname.
    // 127.0.0.1 itself is an IP and is never allowlisted by design.
    const testGateway = new HttpConnectAllowlistGateway({
      domains: ["localhost"],
      hostAlias: "127.0.0.1",
      bindHost: "127.0.0.1",
      networkName: "nitely-egress-connect-test",
    });
    gateways.push(testGateway);
    await testGateway.assertEnforceable();
    const plan = await testGateway.prepareContainerNetwork();
    const proxyPort = Number(
      new URL(plan.containerEnv.HTTPS_PROXY!).port,
    );

    const allowed = await connectViaProxy({
      proxyPort,
      targetHost: "localhost",
      targetPort: upstreamPort,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain("hello");

    const denied = await connectViaProxy({
      proxyPort,
      targetHost: "evil.example",
      targetPort: 443,
    });
    expect(denied.statusCode).toBe(403);

    upstream.close();
  });

  it("createNetworkAllowlistGateway returns undefined for none policy", () => {
    expect(
      createNetworkAllowlistGateway({
        policy: { mode: "none", domains: [], gatewayId: "none" },
      }),
    ).toBeUndefined();
  });

  it("createNetworkAllowlistGateway rejects unknown gateway ids", () => {
    expect(() =>
      createNetworkAllowlistGateway({
        policy: {
          mode: "allowlist",
          domains: ["api.openai.com"],
          gatewayId: "ebpf-magic",
        },
      }),
    ).toThrow(/unsupported OCI network gateway/i);
  });
});

describe("CONTAINER_GATEWAY_SCRIPT", () => {
  const sidecars: ChildProcess[] = [];

  afterEach(() => {
    while (sidecars.length > 0) {
      sidecars.pop()?.kill("SIGKILL");
    }
  });

  // The sidecar only ever runs inside a container, so run its source directly:
  // a proxy that answers with anything but a well-formed HTTP response denies
  // every allowlisted run just as loudly as a misjudged domain would.
  it("completes allowlisted CONNECT tunnels and denies the rest", async () => {
    const upstream = net.createServer((socket) => {
      socket.write("hello");
      socket.end();
    });
    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const gatewayPort = await reservePort();

    const sidecar = spawn(process.execPath, ["-e", CONTAINER_GATEWAY_SCRIPT], {
      env: {
        ...process.env,
        NITELY_GATEWAY_ALLOWLIST: JSON.stringify(["localhost"]),
        NITELY_GATEWAY_PORT: String(gatewayPort),
      },
      stdio: "ignore",
    });
    sidecars.push(sidecar);
    await waitForListener(gatewayPort);

    const allowed = await connectViaProxy({
      proxyPort: gatewayPort,
      targetHost: "localhost",
      targetPort: upstreamPort,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain("hello");

    const denied = await connectViaProxy({
      proxyPort: gatewayPort,
      targetHost: "evil.example",
      targetPort: 443,
    });
    expect(denied.statusCode).toBe(403);

    upstream.close();
  });
});

async function reservePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolvePromise) => {
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

async function waitForListener(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await new Promise<boolean>((resolvePromise) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolvePromise(false);
      });
    });
    if (ready) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("container gateway script never started listening");
}

async function connectViaProxy(input: {
  proxyPort: number;
  targetHost: string;
  targetPort: number;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolvePromise, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: input.proxyPort,
      method: "CONNECT",
      path: `${input.targetHost}:${input.targetPort}`,
    });
    // Node hands any bytes that arrived alongside the 200 response to this
    // handler as `head`, not through later `data` events. The upstream here
    // writes and closes as soon as it is connected, so over loopback the 200
    // and the payload routinely land in one read.
    req.on("connect", (res, socket, head) => {
      const chunks: Buffer[] = [];
      if (head?.length) chunks.push(head);
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        resolvePromise({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      socket.on("error", reject);
      if (res.statusCode !== 200) {
        socket.resume();
        socket.end();
      }
    });
    req.on("error", reject);
    req.end();
  });
}
