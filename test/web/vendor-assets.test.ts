import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startWebServer, type WebServer } from "../../src/web/server.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-vendor-assets-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    }),
    "utf8",
  );
  return repo;
}

describe("Web Console vendored browser runtime", () => {
  it("serves React, ReactDOM and Babel from the server instead of a public CDN", async () => {
    const server = await startWebServer({
      repoPath: await createRepo(),
      host: "127.0.0.1",
      port: 0,
      providerEnv: {},
      providerCommandStatus: async () => false,
    });
    servers.push(server);

    for (const [path, marker] of [
      ["/vendor/react.js", "React"],
      ["/vendor/react-dom.js", "ReactDOM"],
      ["/vendor/babel.js", "Babel"],
    ] as const) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("javascript");
      expect(await response.text(), path).toContain(marker);
    }
    expect((await fetch(`${server.url}/vendor/../package.json`)).status).not.toBe(200);
    expect((await fetch(`${server.url}/vendor/other.js`)).status).toBe(404);
  });

  it("the console's boot script no longer points at unpkg", async () => {
    const support = await readFile(
      join(import.meta.dirname, "..", "..", "src", "web", "static", "support.js"),
      "utf8",
    );
    expect(support).not.toContain("unpkg.com");
    expect(support).toContain('"/vendor/react.js"');
    expect(support).toContain('"/vendor/react-dom.js"');
    expect(support).toContain('"/vendor/babel.js"');
  });
});
