import type { ResourceReference } from "../connectors/types.js";
import type { Flow, InputContract } from "./schema.js";

export function inputContractSourceReference(
  contract: InputContract,
): ResourceReference | undefined {
  if (contract.source) return contract.source;
  const sourceUrl = contract.sourceUrl ?? contract.source_url;
  if (sourceUrl) {
    return { connector: "source-url", uri: sourceUrl };
  }
  const artifactUri = contract.artifactUri ?? contract.artifact_uri;
  if (artifactUri) {
    return { connector: "nitely-artifact", uri: artifactUri };
  }
  return undefined;
}

export function inputContractHasDefaultSource(contract: InputContract): boolean {
  return inputContractSourceReference(contract) !== undefined;
}

export function flowInputReferences(
  flow: Flow,
  suppliedInputs: Record<string, ResourceReference>,
): Record<string, ResourceReference> {
  const references: Record<string, ResourceReference> = { ...suppliedInputs };
  for (const contract of flow.metadata.inputs ?? []) {
    if (references[contract.id] !== undefined) continue;
    const source = inputContractSourceReference(contract);
    if (source) {
      references[contract.id] = source;
    }
  }
  return references;
}
