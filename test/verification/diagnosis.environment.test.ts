import { describe, expect, it } from 'vitest';

const diagnosis = await import('../../src/verification/diagnosis.js');

describe('verification failure diagnosis', () => {
  it('classifies an explicit missing verification CLI as environment on the first failed test', () => {
    expect(
      diagnosis.classifyVerificationFailures([
        {
          testName: 'pinned CLI preflight',
          error: {
            name: 'VerificationEnvironmentError',
            code: 'VERIFICATION_CLI_MISSING',
            message: 'codex executable is missing; install Codex 0.162.0',
          },
        },
      ]),
    ).toMatchObject({ category: 'environment', requiresImplementationRework: false });
  });

  it('classifies spawn ENOENT for the verification CLI as environment', () => {
    expect(
      diagnosis.classifyVerificationFailures([
        {
          testName: 'pinned CLI preflight',
          error: { code: 'ENOENT', syscall: 'spawn codex', message: 'spawn codex ENOENT' },
        },
      ]),
    ).toMatchObject({ category: 'environment', requiresImplementationRework: false });
  });

  it('classifies a version-contract mismatch as environment', () => {
    expect(
      diagnosis.classifyVerificationFailures([
        {
          testName: 'pinned CLI preflight',
          error: {
            code: 'VERIFICATION_CLI_VERSION_MISMATCH',
            message: 'expected 2.1.300, found 2.1.299',
          },
        },
      ]),
    ).toMatchObject({ category: 'environment', requiresImplementationRework: false });
  });

  it('keeps mixed environment and real assertion failures as implementation work', () => {
    expect(
      diagnosis.classifyVerificationFailures([
        { testName: 'pinned CLI preflight', error: { code: 'ENOENT', message: 'spawn claude ENOENT' } },
        { testName: 'MCP response', error: { name: 'AssertionError', message: 'expected 200 to be 500' } },
      ]),
    ).toMatchObject({ category: 'implementation', requiresImplementationRework: true });
  });
});
