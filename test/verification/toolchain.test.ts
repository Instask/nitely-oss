import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const toolchain = await import('../../src/verification/toolchain.js');

describe('pinned verification CLI contract', () => {
  it('pins Codex 0.162.0 and Claude Code 2.1.300 in one shared contract', () => {
    expect(toolchain.PINNED_VERIFICATION_TOOLS).toEqual({
      codex: '0.162.0',
      claude: '2.1.300',
    });
  });

  it.each([
    ['codex', '0.162.0'],
    ['claude', '2.1.300'],
  ])('accepts a matching %s executable without making an auth or model request', async (tool, version) => {
    const root = await mkdtemp(join(tmpdir(), 'nitely-verification-'));
    const marker = join(root, 'request-made');
    const executable = join(root, tool);
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${tool} ${version}'; else touch '${marker}'; fi\n`,
    );
    await chmod(executable, 0o755);

    try {
      await expect(toolchain.verifyPinnedCli({ tool, executable })).resolves.toEqual({
        tool,
        version,
        matched: true,
      });
      await expect(import('node:fs/promises').then(({ access }) => access(marker))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing verification CLI as an actionable environment error', async () => {
    await expect(
      toolchain.verifyPinnedCli({ tool: 'codex', executable: '/definitely/missing/nitely-codex' }),
    ).rejects.toMatchObject({
      name: 'VerificationEnvironmentError',
      code: 'VERIFICATION_CLI_MISSING',
      tool: 'codex',
    });
    await expect(
      toolchain.verifyPinnedCli({ tool: 'codex', executable: '/definitely/missing/nitely-codex' }),
    ).rejects.toThrow(/codex|install|PATH/i);
  });

  it('reports a wrong pinned version as an actionable environment error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nitely-verification-'));
    const executable = join(root, 'codex');
    await writeFile(executable, '#!/bin/sh\necho "codex 0.161.0"\n');
    await chmod(executable, 0o755);

    try {
      await expect(toolchain.verifyPinnedCli({ tool: 'codex', executable })).rejects.toMatchObject({
        name: 'VerificationEnvironmentError',
        code: 'VERIFICATION_CLI_VERSION_MISMATCH',
        expectedVersion: '0.162.0',
        actualVersion: '0.161.0',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
