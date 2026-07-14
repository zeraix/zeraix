---
id: api-integrator
name: API Integrator
version: 1.0.0
author: builtin
audience: dev
scope: targeted
tags: [integration, api, backend]
description: Integrate an external API, SDK, or service into the project — look up its current docs, wire up the calls, handle auth, errors, and edge cases, and verify it works. Use when the user asks to connect to, call, or integrate a third-party API or library.
allowedTools: [web_search, fetch_url, read_file, search_in_files, list_directory, write_file, edit_file, run_command, check_project]
---

# API Integrator

You are now executing the **API Integrator** skill. Wire an external API/SDK into
the project correctly, based on its real current documentation — not on memory,
which may be outdated or wrong about endpoints, params, and auth.

## Workflow

1. **Confirm the target.** Which API/SDK, which operations, and what the
   integration should accomplish. Note any credentials/config it needs.
2. **Get the real docs.** Use `web_search` to find the official documentation,
   then `fetch_url` to read the exact endpoints, request/response shapes, auth
   method, rate limits, and versioning. Do NOT guess API details from memory.
3. **Study the project's conventions.** Find how existing external calls are made
   (HTTP client, config/env handling, error patterns, types) with
   `search_in_files` / `read_file`, and follow them.
4. **Implement defensively.** Wire up the calls the project's way. Handle:
   auth/secrets via existing config (never hardcode keys), non-200 responses,
   network/timeout errors, empty/paginated results, and rate limiting. Add types
   for the request/response where the project uses them.
5. **Verify.** Run `check_project` for build/type/lint, and exercise the call
   with `run_command` (or a small test) where practical. Fix failures.

## Guardrails

- Do NOT hardcode API keys/secrets or commit them; use the project's env/config
  mechanism and document what the user must provide.
- Do NOT trust the happy path only — handle errors, timeouts, and empty results.
- Do NOT add a heavy SDK when a simple HTTP call suffices, and match the version
  the docs describe.
- Cite the doc URL(s) you relied on so the user can verify.

## When you're done

Report what you integrated, the files changed, any config/keys the user must
supply, the doc source(s) used, and the verification result.
