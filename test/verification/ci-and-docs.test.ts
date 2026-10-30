import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('verification toolchain wiring and documentation', () => {
  it('pins Claude beside Codex and exports real-CLI regression flags in CI', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toMatch(/Claude(?: Code)?[^\n]*(?:2\.1\.300)/i);
    expect(ci).toMatch(/Codex[^\n]*(?:0\.162\.0)/i);
    expect(ci).toMatch(/(?:TEST_BINARY|VERIFICATION).*CLAUDE|(?:REQUIRE|REAL).*CLAUDE/i);
    expect(ci).toMatch(/(?:TEST_BINARY|VERIFICATION).*CODEX|(?:REQUIRE|REAL).*CODEX/i);
  });

  it('documents the OCI build and pinned verification invocation without private host paths', async () => {
    const docs = `${await readFile('docs/execution-backends.md', 'utf8')}\n${await readFile('docs/running-flows.md', 'utf8')}`;
    expect(docs).toMatch(/runner.*image|image.*build/i);
    expect(docs).toMatch(/verifyPinnedCli|verification.*(?:codex|claude)|--version/i);
    expect(docs).toMatch(/TMPDIR|tmpdir/i);
    expect(docs).not.toMatch(/\/Users\/|\/home\/[^\s/]+\/|10\.\d+\.\d+\.\d+/);
  });
});
