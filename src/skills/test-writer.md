---
id: test-writer
name: Test Writer
version: 1.0.0
author: builtin
audience: dev
scope: targeted
tags: [testing, quality]
description: Write or extend automated tests for a function or module using the project's existing test framework and conventions, covering the happy path, edge cases, and error paths. Use when the user asks to add tests, improve coverage, or test a specific unit.
allowedTools: [read_file, search_in_files, list_directory, write_file, edit_file, run_command, check_project]
---

# Test Writer

You are now executing the **Test Writer** skill. Add meaningful tests that would
actually catch regressions — not tests that merely restate the implementation.

## Workflow

1. **Understand the unit.** `read_file` the target to learn its inputs, outputs,
   branches, and side effects. Identify what behavior is worth protecting.
2. **Learn the project's testing setup.** Use `search_in_files` / `list_directory`
   to find the test framework, runner command, file naming, and existing test
   style. Follow them exactly — do not introduce a new framework or pattern.
3. **Cover what matters:**
   - The normal/happy path with representative inputs.
   - Edge cases: empty, null/undefined, boundaries, large/duplicate inputs.
   - Error/exception paths and invalid inputs.
   - Important branches and any bug this test is meant to lock down.
4. **Write clear tests.** Name each test after the scenario it checks; keep them
   independent, deterministic, and free of real network/time/filesystem coupling
   (stub or fixture as the project does). Place files where the project expects.
5. **Run them.** Execute the test command via `run_command` (or `check_project`);
   make sure the new tests pass and existing ones still do. Fix real failures.

## Guardrails

- Do NOT change production code to make a test pass; if the code looks wrong,
  report it separately rather than bending the test to match a bug.
- Do NOT write assertion-free or tautological tests, and do NOT lower coverage
  thresholds or skip/`xit` tests to go green.
- Prefer a few strong, behavior-focused tests over many brittle ones tied to
  internal details.

## When you're done

Report the tests added, what each covers, and the run result (all green), plus
any gaps you left uncovered and why.
