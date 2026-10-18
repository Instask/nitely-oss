import { describe, expect, it } from "vitest";

import {
  repositoryKnowledgeQuota,
  selectStageKnowledgeMatches,
} from "../../src/run/knowledge-selection.js";

const attached = ["a1", "a2", "a3", "a4", "a5", "a6"];
const repository = ["r1", "r2", "r3"];
const always = () => true;

describe("stage knowledge selection", () => {
  it("reserves a repository quota that grows with topK and is absent at topK 1", () => {
    expect([1, 2, 6, 8, 12].map(repositoryKnowledgeQuota)).toEqual([0, 1, 1, 2, 3]);
  });

  it("keeps repository context when attached knowledge alone fills topK", () => {
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 6, fits: always }))
      .toEqual(["a1", "a2", "a3", "a4", "a5", "r1"]);
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 8, fits: always }))
      .toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "r1", "r2"]);
  });

  it("gives attached knowledge the single slot at topK 1", () => {
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 1, fits: always })).toEqual(["a1"]);
    expect(selectStageKnowledgeMatches({ attached: [], repository, topK: 1, fits: always })).toEqual(["r1"]);
  });

  it("lets repository passages fill slots attached knowledge leaves empty", () => {
    expect(selectStageKnowledgeMatches({ attached: ["a1"], repository, topK: 6, fits: always }))
      .toEqual(["a1", "r1", "r2", "r3"]);
  });

  it("holds the quota against the token budget, dropping extra repository passages first", () => {
    const fitsThree = (selected: readonly string[]) => selected.length <= 3;
    expect(selectStageKnowledgeMatches({ attached: ["a1"], repository, topK: 6, fits: fitsThree }))
      .toEqual(["a1", "r1", "r2"]);
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 6, fits: fitsThree }))
      .toEqual(["a1", "a2", "r1"]);
    const fitsOne = (selected: readonly string[]) => selected.length <= 1;
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 6, fits: fitsOne })).toEqual(["r1"]);
    expect(selectStageKnowledgeMatches({ attached, repository, topK: 6, fits: () => false })).toEqual([]);
  });

  it("keeps the attached-only selection unchanged when there is no repository context", () => {
    expect(selectStageKnowledgeMatches({ attached, repository: [], topK: 4, fits: always }))
      .toEqual(["a1", "a2", "a3", "a4"]);
  });
});
