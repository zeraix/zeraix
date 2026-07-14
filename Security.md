# Security Policy

Zeraix is a local-first AI workstation that can read files, execute tools, and interact with models on your machine. We take security seriously and appreciate responsible disclosure from the community.

## 🔒 Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report them privately via one of the following channels:

- **Email:** fergus@zeraix.com
- **GitHub Private Vulnerability Reporting:** use the ["Report a vulnerability"](../../security/advisories/new) button on this repository (if enabled)

Please include as much of the following as possible:

- Type of vulnerability (e.g., prompt injection leading to unintended tool execution, path traversal, privilege escalation, data exfiltration)
- Affected component and version
- Steps to reproduce, or a proof-of-concept
- Potential impact as you understand it

## ⏱️ What to Expect

- **Acknowledgment** of your report within **72 hours**
- An initial **assessment** within **7 days**
- We will keep you informed of progress toward a fix and coordinate a disclosure timeline with you
- With your permission, we are happy to credit you in the release notes once the fix ships

## 🎯 Scope

In scope:

- The Zeraix client and all code in this repository
- Vulnerabilities in how the client handles local file access, tool/command execution, model prompts, and network communication

Out of scope:

- Vulnerabilities in third-party models, runtimes, or dependencies (please report those upstream — but feel free to notify us so we can pin or patch)
- Social engineering, physical attacks, or issues requiring a compromised host machine
- Denial of service against your own local instance

## 🔐 Supported Versions

We provide security fixes for the **latest released version**. Please update to the most recent release before reporting, when possible.

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older versions | ❌ |

---

Thank you for helping keep Zeraix and its users safe.
