# Auto-Update Rules

Versioning scheme: [Semantic Versioning 2.0.0 (SemVer)](https://semver.org/), format `X.Y.Z` (`MAJOR.MINOR.PATCH`)

---

## 1. Version Number Definitions

| Position | Name | Meaning | Example Triggers |
|---|---|---|---|
| X | MAJOR | Incompatible / breaking API or behavior changes | Removed endpoints, changed data schema, breaking refactors |
| Y | MINOR | Backward-compatible new functionality | New API, new config option, new feature module |
| Z | PATCH | Backward-compatible bug fixes | Bug fixes, performance tuning, security patches, copy fixes |

**Additional rules:**
- Pre-release versions: `X.Y.Z-alpha.1`, `X.Y.Z-beta.2`, `X.Y.Z-rc.1` (lower precedence than the final release)
- Build metadata: `X.Y.Z+20260722` (does not affect version precedence, identification only)
- `0.Y.Z` is treated as initial development — no compatibility guarantees, may change at any time

---

## 2. Auto-Update Policy (by magnitude of version change)

### 2.1 PATCH Updates (Z changes, e.g. 1.2.3 → 1.2.4)
- **Policy: Auto-update, no user confirmation required**
- Trigger: Only the patch number changes; MAJOR and MINOR remain the same
- Use cases: security patches, crash fixes, performance improvements
- Delivery: silent download + silent install (background)
- Exception: if release notes are flagged `security-critical`, the update is enforced and older versions are blocked from running

### 2.2 MINOR Updates (Y changes, e.g. 1.2.3 → 1.3.0)
- **Policy: Auto-update by default, user may disable**
- Trigger: new backward-compatible functionality; MAJOR unchanged
- Delivery:
  - Download may complete automatically
  - A non-blocking notification is shown before/after install ("Updated to X.Y.Z — see what's new")
  - Users may opt into "notify only, do not auto-install" in settings
- Compatibility requirement: MINOR updates must remain compatible with all existing configs/data under the same MAJOR version

### 2.3 MAJOR Updates (X changes, e.g. 1.x.x → 2.0.0)
- **Policy: No silent auto-update — explicit user confirmation required**
- Trigger: contains breaking changes
- Delivery:
  1. On detecting a new MAJOR version, notify only — do not download automatically
  2. Show a breaking-changes list and a migration guide link
  3. Download and install only after explicit user confirmation
  4. Automatically back up old configs/data before install (to support rollback)
- Forced-upgrade exception: if the old MAJOR version has reached End-of-Life (EOL) and poses a serious security risk, upgrade may be forced, but advance notice (≥7 days) is required

### 2.4 Pre-release Versions (alpha/beta/rc)
- **Policy: Not auto-updated by default**
- Delivered only to users who have explicitly opted into the Beta Channel
- Pre-release-to-pre-release updates may be automatic (e.g. `1.3.0-beta.1 → 1.3.0-beta.2`)
- Moving from a pre-release to the final release (e.g. `1.3.0-rc.1 → 1.3.0`) is treated as a normal update and follows the rules above

---

## 3. Version Comparison & Update Determination

1. Compare MAJOR first, then MINOR, then PATCH (higher numeric value = newer)
2. A version with a pre-release label is **lower precedence** than the same numbered version without one
   - Example: `1.0.0-alpha < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0`
3. Build metadata (`+xxx`) **does not** factor into precedence comparisons
4. Do not silently jump across multiple MAJOR versions in one update (e.g. 1.x → 3.x should first surface the changes for 1.x → 2.x)

---

## 4. Update Channels

| Channel | Version Types Received | Default Auto-Update Scope |
|---|---|---|
| Stable | Final release versions only | PATCH fully automatic; MINOR automatic by default |
| Beta | Includes rc/beta versions | PATCH, MINOR, and pre-release all automatic; MAJOR still requires confirmation |
| Alpha/Nightly | All builds, including alpha | Everything except MAJOR is automatic; opt-in required |

---

## 5. Rollback Rules

- If a PATCH/MINOR update fails or causes a crash rate above threshold (e.g. 1%), automatically roll back to the last known-good version
- MAJOR updates may be rolled back on failure, but if user data/config has already been migrated by incompatible changes, the user must be clearly informed that some data may not be recoverable
- Rollback itself does not alter version semantics — it restores the full state corresponding to the target version

---

## 6. Changelog Requirements

Every release must ship a structured changelog, at minimum labeling:

```
## [X.Y.Z] - 2026-07-22
### Added        # corresponds to MINOR
### Changed
### Fixed        # corresponds to PATCH
### Deprecated
### Removed      # corresponds to MAJOR (breaking changes must be highlighted)
### Security
```

---

## 7. Quick Reference Table

| Change Type | Version Digit | Auto-Update? | User Confirmation Needed? |
|---|---|---|---|
| Bug fix / security patch | PATCH | ✅ Yes | ❌ No |
| New backward-compatible feature | MINOR | ✅ Default on (can disable) | ⚠️ Notify only |
| Breaking / incompatible change | MAJOR | ❌ No | ✅ Required |
| Preview / test build | Pre-release tag | ❌ Off by default | ✅ Requires opt-in to Beta channel |

---

*These rules can be adapted in implementation detail for a specific product (desktop client, SDK, backend service, etc.), but the mapping between version-number semantics and update aggressiveness should remain consistent, so that downstream dependents can safely assess compatibility risk from the version number alone.*
