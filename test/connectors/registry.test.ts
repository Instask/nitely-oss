import { describe, expect, it } from "vitest";

import { GoogleDriveConnector } from "../../src/connectors/google-drive.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import type {
  Connector,
  ResourceReference,
} from "../../src/connectors/types.js";

class MemoryConnector implements Connector {
  readonly type = "memory";

  async fetch(reference: ResourceReference) {
    return {
      sourceUri: reference.uri,
      mediaType: "text/plain",
      content: Buffer.from("spec content"),
      revision: "revision-1",
    };
  }
}

describe("ConnectorRegistry", () => {
  it("resolves a resource through its connector", async () => {
    const registry = new ConnectorRegistry([new MemoryConnector()]);

    const result = await registry.fetch({
      connector: "memory",
      uri: "memory://spec",
    });

    expect(result.content.toString("utf8")).toBe("spec content");
    expect(result.sourceUri).toBe("memory://spec");
  });

  it("retrieves a registered connector by type", () => {
    const connector = new MemoryConnector();
    const registry = new ConnectorRegistry([connector]);

    expect(registry.get("memory")).toBe(connector);
  });

  it("rejects duplicate connector types", () => {
    expect(
      () =>
        new ConnectorRegistry([
          new MemoryConnector(),
          new MemoryConnector(),
        ]),
    ).toThrow(/duplicate connector type: memory/);
  });

  it("resolves a registered google-drive connector", () => {
    const connector = new GoogleDriveConnector();
    const registry = new ConnectorRegistry([connector]);

    expect(registry.get("google-drive")).toBe(connector);
  });

  it("rejects unknown connector types", async () => {
    const registry = new ConnectorRegistry([]);

    await expect(
      registry.fetch({
        connector: "google-drive",
        uri: "https://docs.google.com/document/d/example",
      }),
    ).rejects.toThrow(/unknown connector type: google-drive/);
  });
});
