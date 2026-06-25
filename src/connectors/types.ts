export interface ResourceReference {
  connector: string;
  uri: string;
  options?: Record<string, unknown>;
}

export interface FetchedResource {
  sourceUri: string;
  mediaType: string;
  content: Buffer;
  revision?: string;
  metadata?: Record<string, string>;
}

export interface Connector {
  readonly type: string;
  fetch(reference: ResourceReference): Promise<FetchedResource>;
}
