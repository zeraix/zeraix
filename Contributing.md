# Contributing to Zeraix

Thank you for your interest in contributing to Zeraix! We welcome contributions from the community — bug reports, feature suggestions, documentation improvements, and code.

Please read this document before submitting your first contribution.

## ⚖️ Legal Notice (Please Read First)

Zeraix is developed and maintained by the Zeraix team. The contents of this repository are licensed under the **Apache License 2.0** unless a file or directory clearly states otherwise. Separately licensed third-party models, runtimes, libraries, and downloaded components remain governed by their respective licenses.

**By submitting a contribution (pull request, patch, or code snippet) to this repository, you agree that:**

1. Your contribution is your original work, or you have the legal right to submit it.
2. Unless you explicitly state otherwise, you submit the contribution under the Apache License 2.0 without additional terms or conditions, as described in Section 5 of that license.
3. Your contribution does not include third-party code or other material that is incompatible with Apache-2.0 or that you do not have the right to submit.
4. You identify the source and license of any third-party material included in your contribution.

If you are contributing on behalf of your employer, please make sure you are authorized to do so.

## 🐛 Reporting Bugs

- Search [existing issues](../../issues) first to avoid duplicates.
- Use a clear title and include: your OS and hardware, Zeraix version, steps to reproduce, expected vs. actual behavior, and relevant logs.
- **Do not report security vulnerabilities in public issues.** See [Security.md](./Security.md) instead.

## 💡 Suggesting Features

Open an issue with the `enhancement` label. Please describe the problem you are trying to solve, not just the solution — this helps us understand the use case.

## 🔀 Submitting Code

1. **Fork** the repository and create your branch from `main`:
   ```
   git checkout -b feat/your-feature-name
   ```
2. **Keep changes focused.** One pull request should address one concern.
3. **Follow the existing code style.** Run the linter and formatter before committing.
4. **Add tests** where it makes sense, and make sure the existing test suite passes.
5. **Write a clear PR description** explaining what the change does and why.

### Commit Messages

We use conventional commit prefixes:

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `refactor:` code change that neither fixes a bug nor adds a feature
- `test:` adding or fixing tests
- `chore:` build process, tooling, dependencies

## 🧭 Scope of This Repository

This repository contains the **Zeraix client** — the local-first AI workstation that runs on your machine. The cloud-side services and routing infrastructure are proprietary and are **not** open to external contribution. Pull requests attempting to reimplement or interface with proprietary internals may be declined.

## 📜 Code of Conduct

Be respectful and constructive. We are building this together. (If a `CODE_OF_CONDUCT.md` is present in this repository, it applies to all project spaces.)

## ❓ Questions

- Licensing questions: review the [Apache License 2.0](./LICENSE) or open a discussion.
- Commercial use or partnership inquiries: contact us at **emma@zeraix.com**.

---

*The Zeraix team reserves the right to decline any contribution at its discretion. Maintainers' decisions on merging are final.*
