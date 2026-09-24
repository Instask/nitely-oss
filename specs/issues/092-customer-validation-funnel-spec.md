# Issue 92 Spec: Customer Validation Funnel

## Problem

Nitely's commercialization depends on a specific buyer pain: teams use AI coding
tools for real engineering work, but outputs often fail to become reviewable PRs
because context, logs, retries, recovery, and evidence are scattered or missing.

## Goals

- Prepare a repeatable interview workflow for 5 target teams or agencies.
- Capture concrete failed AI coding attempts with enough detail to reconstruct
  the workflow.
- Classify failures by primary failure point.
- Produce a recommendation format: continue, narrow buyer/use case, or pause.
- Make the validation output usable by #93 positioning and #95 pilot packaging.

## Non-Goals

- Claim that interviews have been completed before they happen.
- Replace live customer conversations with internal assumptions.
- Implement product features from interview learnings before classification.

## Acceptance Criteria

- 5 interviews completed with notes.
- At least 3 real failed AI coding attempts collected with enough detail to
  reconstruct the workflow.
- Each failure is classified by primary failure point.
- A short recommendation is written: continue, narrow buyer/use case, or pause
  commercialization work.

## Current Delivery

This PR prepares the interview system and templates. The issue should remain
open until 5 real interviews and the recommendation are recorded.
