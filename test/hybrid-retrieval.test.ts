import { describe, expect, it, vi } from 'vitest';
import {
  benchmarkFixture,
  buildComparisonReport,
  packCandidates,
  prepareContext,
  runBenchmark,
} from '../src/hybrid-retrieval.js';

describe('hybrid retrieval benchmark fixture', () => {
  it('contains at least five repository questions, including a single-file answer and an out-of-repository question', () => {
    expect(benchmarkFixture.questions.length).toBeGreaterThanOrEqual(5);
    expect(benchmarkFixture.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ answerKind: 'single-source-file' }),
        expect.objectContaining({ answerKind: 'out-of-repository' }),
      ]),
    );
  });
});

describe('token-budgeted context packing', () => {
  const candidates = [
    {
      path: 'src/first.ts',
      lineRange: { start: 1, end: 1 },
      text: 'aaaa',
      sourceRevision: 'fixture-revision',
      relevanceScore: 1,
      reason: 'lexical match',
    },
    {
      path: 'src/second.ts',
      lineRange: { start: 2, end: 2 },
      text: 'bbbb',
      sourceRevision: 'fixture-revision',
      relevanceScore: 0.9,
      reason: 'semantic match',
    },
    {
      path: 'src/third.ts',
      lineRange: { start: 3, end: 3 },
      text: 'cccc',
      sourceRevision: 'fixture-revision',
      relevanceScore: 0.8,
      reason: 'lexical match',
    },
  ];

  it('keeps the exact deterministic order and paths that fit a 30-token budget, and reports dropped candidates', () => {
    const result = packCandidates(candidates, 30);

    expect(result.pack.map((snippet) => snippet.path)).toEqual([
      'src/first.ts',
      'src/second.ts',
    ]);
    expect(result.dropped.map((candidate) => candidate.path)).toEqual([
      'src/third.ts',
    ]);
    expect(result.pack).toEqual([
      expect.objectContaining({
        path: 'src/first.ts',
        lineRange: { start: 1, end: 1 },
        sourceRevision: 'fixture-revision',
        relevanceScore: 1,
        reason: 'lexical match',
      }),
      expect.objectContaining({
        path: 'src/second.ts',
        lineRange: { start: 2, end: 2 },
        sourceRevision: 'fixture-revision',
        relevanceScore: 0.9,
        reason: 'semantic match',
      }),
    ]);
  });

  it('uses caller-supplied snippet text and does not read arbitrary paths or follow outside-root symlinks', () => {
    const result = packCandidates([
      {
        ...candidates[0],
        path: 'link/outside.txt',
        text: 'caller supplied text',
      },
    ], 30, { repositoryRoot: '/fixture/repository' });

    expect(result.pack).toEqual([]);
    expect(result.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'link/outside.txt' }),
      ]),
    );
  });

  it('omits token-shaped secret text and counts it as sanitized', () => {
    const result = packCandidates([
      {
        ...candidates[0],
        text: 'token=ghp_123456789012345678901234567890123456',
      },
    ], 30);

    expect(result.pack).toEqual([]);
    expect(result.sanitized).toBe(1);
  });

  it('returns an empty pack for a zero budget', () => {
    expect(packCandidates(candidates, 0).pack).toEqual([]);
  });

  it('rejects empty paths and line ranges outside the supplied snippet as invalid', () => {
    const result = packCandidates([
      { ...candidates[0], path: '' },
      { ...candidates[1], lineRange: { start: 4, end: 5 }, text: 'one\ntwo' },
    ], 30);

    expect(result.pack).toEqual([]);
    expect(result.invalid.map((candidate) => candidate.path)).toEqual(['', 'src/second.ts']);
  });

  it('keeps missing semantic scores missing and reports that the semantic signal was unavailable', () => {
    const result = packCandidates([
      { ...candidates[0], semanticScore: undefined },
    ], 30);

    expect(result.pack[0]).toEqual(
      expect.objectContaining({ semanticScore: undefined }),
    );
    expect(result.report).toContain('semantic signal was unavailable');
  });
});

describe('comparison report and benchmark behavior', () => {
  it('reports baseline and hybrid token counts and ends with exactly one decision line', () => {
    const report = buildComparisonReport({
      baselineTokenCount: 42,
      hybridTokenCount: 30,
      proposals: [],
    });

    expect(report).toContain('Baseline tokens: 42');
    expect(report).toContain('Hybrid tokens: 30');
    expect(report.match(/^Decision: (go|no-go)$/gm)).toHaveLength(1);
    expect(report.trim().split('\n').at(-1)).toMatch(/^Decision: (go|no-go)$/);
  });

  it('returns extracted decisions, constraints, and preferences as proposals without writing authoritative storage', async () => {
    const write = vi.fn();
    const result = await runBenchmark({
      fixture: benchmarkFixture,
      writeAuthoritativeContext: write,
    });

    expect(result.proposals).toEqual(expect.any(Array));
    expect(write).not.toHaveBeenCalled();
  });

  it('fails when the fixture cannot be read and does not produce a go decision', async () => {
    await expect(runBenchmark({ fixturePath: '/missing/fixture.json' })).rejects.toThrow();
  });
});

describe('hybrid retrieval feature flag', () => {
  it('does not call the hybrid packer when NITELY_HYBRID_RETRIEVAL is unset', async () => {
    const hybridPacker = vi.fn();
    const existingEvidence = { id: 'flow-evidence' };

    const result = await prepareContext({
      env: {},
      existingFlowEvidence: existingEvidence,
      hybridPacker,
    });

    expect(hybridPacker).not.toHaveBeenCalled();
    expect(result).toEqual(existingEvidence);
  });

  it('uses hybrid ranking only when NITELY_HYBRID_RETRIEVAL is 1', async () => {
    const hybridPacker = vi.fn().mockResolvedValue({ pack: [] });

    await prepareContext({
      env: { NITELY_HYBRID_RETRIEVAL: '1' },
      existingFlowEvidence: { id: 'flow-evidence' },
      hybridPacker,
    });

    expect(hybridPacker).toHaveBeenCalledTimes(1);
  });
});
