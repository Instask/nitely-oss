import type {
  Connector,
  FetchedResource,
  ResourceReference,
} from "./types.js";

export class ConnectorRegistry {
  readonly #connectors = new Map<string, Connector>();

  constructor(connectors: Iterable<Connector>) {
    for (const connector of connectors) {
      if (this.#connectors.has(connector.type)) {
        throw new Error(`duplicate connector type: ${connector.type}`);
      }
      this.#connectors.set(connector.type, connector);
    }
  }

  get(type: string): Connector {
    const connector = this.#connectors.get(type);
    if (!connector) {
      throw new Error(`unknown connector type: ${type}`);
    }
    return connector;
  }

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    return await this.get(reference.connector).fetch(reference);
  }
}
