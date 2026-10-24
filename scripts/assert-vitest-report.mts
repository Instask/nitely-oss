// Fails unless every named test in a Vitest JSON report passed.
//
// Gated integration tests (`it.runIf`) report "skipped" when their
// environment is missing, and Vitest exits 0 for skipped tests. A CI job that
// exists to run them uses this script so a broken setup step cannot turn the
// job green without running anything.
//
//   tsx scripts/assert-vitest-report.mts <report.json> <title substring>...
//
// Each substring must match at least one test's full name, and every matching
// test must have passed.

import { readFileSync } from "node:fs";

interface AssertionResult {
  fullName: string;
  status: string;
}

interface Report {
  testResults: { name: string; assertionResults: AssertionResult[] }[];
}

const [reportPath, ...required] = process.argv.slice(2);
if (!reportPath || required.length === 0) {
  console.error("usage: assert-vitest-report.mts <report.json> <title substring>...");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
const results = report.testResults.flatMap((file) => file.assertionResults);
const problems: string[] = [];

for (const title of required) {
  const matches = results.filter((result) => result.fullName.includes(title));
  if (matches.length === 0) {
    problems.push(`no test matches "${title}"`);
    continue;
  }
  for (const match of matches) {
    if (match.status !== "passed") {
      problems.push(`${match.status}: ${match.fullName}`);
    }
  }
}

if (problems.length > 0) {
  console.error("Required integration tests did not pass:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`All ${required.length} required test groups passed.`);
