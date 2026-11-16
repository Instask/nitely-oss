#!/usr/bin/env bash
# Pin Claude Code for the real-CLI MCP restriction test
# (test/run/execution/claude-mcp-servers.real.test.ts).
# The Typecheck job runs this script. stdout is only the binary path;
# the workflow exports it as NITELY_TEST_CLAUDE_BIN and sets
# NITELY_TEST_REQUIRE_CLAUDE=1 so a missing pin fails the suite.
set -euo pipefail
prefix="${RUNNER_TEMP:-/tmp}/claude-cli"
npm install --no-save --no-audit --no-fund --prefix "$prefix" @anthropic-ai/claude-code@2.1.263 >&2
echo "$prefix/node_modules/.bin/claude"
