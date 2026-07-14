---
id: refactor
name: Refactor
version: 1.0.0
author: builtin
audience: dev
scope: general
tags: [quality, refactoring, maintainability]
description: Restructure existing code to improve its readability, structure, and maintainability WITHOUT changing its external behavior (extract functions, remove duplication, rename for clarity, simplify conditionals). Use when the user asks to refactor, clean up, tidy, restructure, or simplify code.
allowedTools: [read_file, search_in_files, list_directory, edit_file, write_file, check_project]
---

# Refactor

You are now executing the **Refactor** skill. Refactoring means improving the
internal structure of existing code **without changing its observable behavior**.
Correctness is the ceiling: a refactor that changes what the code does is a bug,
not a refactor.

## Golden rule

Preserve behavior. Same inputs → same outputs, same side effects, same public
API. If you believe behavior *should* change (a real bug, a missing case), do not
silently fix it — call it out separately and let the user decide.

## Workflow

1. **Scope it.** Confirm exactly what to refactor (a function, a file, a module)
   and why (readability, duplication, long function, deep nesting, unclear
   names). Do not expand the blast radius beyond what was asked.

2. **Establish a baseline first.** Before touching anything, understand current
   behavior and how it's verified. Run `check_project` to confirm the code builds
   and tests pass *now* — you need a known-good starting point to compare against.
   If there is no way to verify behavior, say so and proceed with extra caution.

3. **Map usages before editing.** Use `list_directory` / `search_in_files` to
   find every caller and reference of what you're about to change (especially
   before renaming or moving anything). `read_file` the relevant parts — don't
   assume.

4. **Change in small, safe steps.** Apply ONE refactoring at a time with
   `edit_file`. After each meaningful step, re-run `check_project` and fix any
   regression immediately before moving on. Never batch many risky changes and
   verify only at the end.

5. **Match the surrounding code.** Follow the file's existing naming, style,
   patterns, import order, and comment density. A refactor should look like it was
   always there — not like a different author dropped in.

6. **Verify and summarize.** End with a green `check_project`, then briefly
   describe *what* structural changes you made and confirm behavior is unchanged.

## Common refactorings

- **Extract function / variable** — pull a named unit out of a long or repeated
  block; name it after what it does.
- **Remove duplication (DRY)** — collapse copy-pasted logic into one reusable
  place, but only when the duplicates are genuinely the same concern.
- **Rename for clarity** — give variables, functions, and types intention-
  revealing names; update every reference.
- **Simplify conditionals** — use guard clauses / early returns to flatten deep
  nesting; replace tangled boolean logic with clearly named predicates.
- **Split large units** — break an overgrown function, component, or module into
  cohesive smaller pieces.
- **Remove dead code** — delete unreachable branches, unused variables, and
  commented-out code (only when you're certain it's truly unused — search first).

## Guardrails

- Do NOT change public APIs, function signatures, exported names, on-disk
  formats, or behavior unless the user explicitly asked for it.
- Do NOT add new dependencies, frameworks, or abstractions the task didn't call
  for — refactoring reduces incidental complexity, it doesn't add layers.
- Do NOT mix refactoring with feature work or bug fixes in the same pass; keep
  behavior-preserving changes separate from behavior-changing ones.
- Do NOT reformat or reorganize code the user didn't ask about just because you
  are nearby.
- Prefer the smallest change that achieves the goal. If a refactor balloons or
  gets risky, stop and check in with the user before continuing.

## When you're done

Report: the files touched, the specific refactorings applied (e.g. "extracted
`validatePayload` from `handleRequest`, removed duplicated retry logic"), the
verification result (`check_project` passed), and an explicit statement that the
external behavior is unchanged. Note anything you deliberately left alone or any
suspected bugs you found but did not fix.
