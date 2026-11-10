#!/usr/bin/env bash
# Pin Claude Code for the real-CLI MCP restriction test
# (test/run/execution/claude-mcp-servers.real.test.ts).
# Add this step to .github/workflows/ci.yml once the installer has `workflow` scope:
#   npm install --no-save --no-audit --no-fund --prefix "$RUNNER_TEMP/claude-cli" @anthropic-ai/claude-code@2.1.263
#   claude_bin="$RUNNER_TEMP/claude-cli/node_modules/.bin/claude"
#   echo "NITELY_CLAUDE_COMMAND=$claude_bin" >> "$GITHUB_ENV"
set -euo pipefail
prefix="${RUNNER_TEMP:-/tmp}/claude-cli"
npm install --no-save --no-audit --no-fund --prefix "$prefix" @anthropic-ai/claude-code@2.1.263
echo "$prefix/node_modules/.bin/claude"
