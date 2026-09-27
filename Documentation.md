# 🛡️ ReleaseGuard AI — Technical Documentation

> **Project:** `orders-api` v2.1.0  
> **Tool:** ReleaseGuard AI — Autonomous Pre-Flight Release Gate  
> **Runtime:** Node.js ≥ 18.0.0  
> **Classification:** Internal Engineering Reference

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Scripts Reference](#3-scripts-reference)
4. [CLI Reference (`bin/releaseguard.js`)](#4-cli-reference)
5. [Dashboard](#5-dashboard)
6. [Migration Sandbox](#6-migration-sandbox)
7. [Release Notes Synthesizer](#7-release-notes-synthesizer)
8. [Finding IDs & Severity Reference](#8-finding-ids--severity-reference)
9. [Configuration & Environment](#9-configuration--environment)
10. [Reproduction & Quick-Start](#10-reproduction--quick-start)

---

## 1. Overview

ReleaseGuard AI is an autonomous pre-flight release gate that runs inside the repository as a set of Node.js scripts. It performs deep static analysis, migration dry-run sandboxing, security audit, API contract drift detection, and autonomous changelog synthesis — with no external runtime dependencies beyond `express` (dashboard) and `better-sqlite3` (sandbox).

**Capabilities at a glance:**

| Capability | Implementation |
|---|---|
| Static security & drift analysis | `scripts/pre-flight-check.js` |
| In-memory migration dry-run | `scripts/migration-sandbox.js` |
| Auto-remediation of fixable findings | `scripts/auto-fix.js` |
| GitHub PR comment generation | `scripts/pr-commenter.js` |
| Autonomous release notes synthesis | `scripts/generate-release-notes.js` |
| Real-time SSE dashboard | `dashboard/server.js` + `dashboard/public/index.html` |
| Interactive developer CLI | `bin/releaseguard.js` |

---

## 2. Architecture

```
bin/releaseguard.js         ← CLI dispatcher (no logic)
│
├── scripts/pre-flight-check.js     ← Detection (pure, no writes)
│     └── scripts/migration-sandbox.js  ← SQLite dry-run (called inline)
│
├── scripts/auto-fix.js             ← Remediation (writes source files)
├── scripts/pr-commenter.js         ← PR comment generator
├── scripts/generate-release-notes.js  ← Changelog synthesizer
│
└── dashboard/
      ├── server.js                 ← Express + SSE endpoint
      └── public/index.html         ← Live terminal UI
```

### Separation of concerns

| Layer | File | Responsibility |
|---|---|---|
| Detection | `pre-flight-check.js` | Reads codebase, emits findings. No writes. |
| Sandbox | `migration-sandbox.js` | Runs SQL in `:memory:` SQLite. No writes. |
| Remediation | `auto-fix.js` | Applies targeted patches. No detection. |
| Reporting | `pr-commenter.js` | Formats markdown. No source writes. |
| Synthesis | `generate-release-notes.js` | Aggregates all data → `RELEASE_NOTES.md` |
| Orchestration | `bin/releaseguard.js` | Dispatches commands. No logic. |
| Dashboard | `dashboard/server.js` | Serves UI, proxies scripts via SSE. |

### Key design principles

- **Zero external runtime deps** for analysis scripts — only `fs`, `path`, `child_process`, `RegExp`.
- **Pure exports** — `runChecks()`, `runSandbox()` are side-effect-free and importable.
- **Idempotent fixes** — `auto-fix.js` checks before patching; re-running is always safe.
- **Graceful degradation** — sandbox failure falls back to `MEDIUM` warning, never crashes pre-flight.

---

## 3. Scripts Reference

### `scripts/pre-flight-check.js`

Runs 12 static checks across 4 domains. **Exports `runChecks()`.**

```bash
node scripts/pre-flight-check.js                 # audit only
node scripts/pre-flight-check.js --fix           # audit + auto-remediate + re-audit
node scripts/pre-flight-check.js --approve-db-risks  # DBA sign-off mode
```

**Exit codes:** `0` = clean / `1` = critical or high findings remain.

Internally calls `runSandbox()` from `migration-sandbox.js` (output silenced) to upgrade the rollback check from file-existence to a live SQL dry-run.

---

### `scripts/migration-sandbox.js`

Executes every `.up.sql` → `.down.sql` pair against an in-memory SQLite database. **Exports `runSandbox()`.**

**Strategy:** For each migration N, spin a fresh `:memory:` DB, apply migrations `0..N` (forward pass), then execute N's `.down.sql`. This ensures prerequisite schema is present before testing each rollback.

```bash
node scripts/migration-sandbox.js          # dry-run all migrations
node scripts/migration-sandbox.js --json   # emit JSON results
npm run test:sandbox
```

**Flags:**
- `DB-ROLLBACK-BROKEN` — DOWN SQL throws a runtime error
- `DB-ROLLBACK-BROKEN` — `.down.sql` file is absent

**PostgreSQL → SQLite shims applied:**

| PG Syntax | SQLite Equivalent |
|---|---|
| `SERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `TIMESTAMP DEFAULT NOW()` | `TEXT DEFAULT CURRENT_TIMESTAMP` |
| `NUMERIC(p,s)` | `REAL` |
| `DROP COLUMN IF EXISTS col` | `DROP COLUMN col` |
| `ALTER COLUMN ... DROP DEFAULT` | _(skipped)_ |

---

### `scripts/generate-release-notes.js`

Five-stage synthesis pipeline that produces `RELEASE_NOTES.md`.

```bash
node scripts/generate-release-notes.js         # write RELEASE_NOTES.md
node scripts/generate-release-notes.js --json  # also emit JSON metadata to stdout
node scripts/generate-release-notes.js --dry   # print only, no file write
npm run release-notes
```

**Pipeline stages:**

| Stage | Data source | Output |
|---|---|---|
| Git context | `git log -n 10 --oneline`, `git diff --name-only HEAD~1` | Branch, SHA, commits, modified files |
| Security & drift | `runChecks()` | All findings with severity + ID |
| Sandbox state | `runSandbox()` | Per-migration pass/fail |
| Semver recommendation | Finding types + commit prefixes | MAJOR / MINOR / PATCH |
| Readiness score | Coverage, findings, sandbox | 0–100 integer |

**Semver logic:**

| Trigger | Recommendation |
|---|---|
| `DB-DESTRUCTIVE`, `API-SCHEMA-*`, `API-METHOD-MISMATCH`, or `BREAKING CHANGE` commits | **MAJOR** |
| Undocumented new endpoints, additive migrations, `feat:` commits | **MINOR** |
| Everything else | **PATCH** |

**Readiness score deductions:**

| Condition | Deduction |
|---|---|
| CRITICAL finding | −20 per finding |
| HIGH finding | −10 per finding |
| MEDIUM finding | −3 per finding |
| DB-ROLLBACK-BROKEN | −15 per migration |
| Untested route files | Up to −20 (proportional) |

---

### `scripts/auto-fix.js`

Applies targeted in-place patches for auto-fixable findings. **Exports `applyFixes(findings)`.**

| Fix ID | Strategy |
|---|---|
| `SEC-ADMIN-AUTH` | Inserts `router.use(requireAuth); router.use(requireRole('admin'))` |
| `API-METHOD-MISMATCH` | Swaps `patch:` → `put:` in spec block |
| `API-SPEC-VERSION` | Rewrites `version:` in `openapi.yaml` info block |
| `TST-MISSING` | Scaffolds Jest/Supertest test boilerplate per route |

---

### `scripts/pr-commenter.js`

Generates a GitHub-flavored Markdown PR comment and writes `PR_COMMENT.md`.

```bash
node scripts/pr-commenter.js
npm run pr-comment
```

---

## 4. CLI Reference

```
releaseguard <command> [flags]
```

| Command | Description |
|---|---|
| `check` | Alias for `audit` |
| `audit` | Run pre-flight checks, print findings table |
| `fix` | Run pre-flight checks + auto-remediate |
| `verify-db` | Run migration dry-run sandbox |
| `notes` | Generate `RELEASE_NOTES.md` |
| `ui` | Launch dashboard on http://localhost:3000 |
| `dba-signoff` | Pre-flight with `--approve-db-risks` |
| `comment` | Generate GitHub PR markdown comment |
| `help` | Show help |

| Flag | Applies to | Description |
|---|---|---|
| `--help` / `-h` | Any | Show help |
| `-v` | Any | Print version and exit |
| `--json` | `notes` | Also emit raw JSON metadata to stdout |
| `--dry` | `notes` | Print only, skip writing `RELEASE_NOTES.md` |

---

## 5. Dashboard

A real-time Express + SSE dashboard served on port 3000.

```bash
node dashboard/server.js
# or
releaseguard ui
```

### API endpoints

| Route | Description |
|---|---|
| `GET /api/audit` | Static analysis of current repo — returns full audit JSON |
| `POST /api/run-audit` | Runs `pre-flight-check.js`, returns stdout + parsed data |
| `GET /api/stream-audit` | **SSE stream** — spawns script as child process, pipes `stdout`/`stderr` line-by-line |

### SSE stream query parameters

| Param | Value | Effect |
|---|---|---|
| `fix` | `1` | Pass `--fix` to pre-flight script |
| `dba` | `1` | Pass `--approve-db-risks` |
| `sandbox` | `1` | Stream `migration-sandbox.js` instead |

### SSE event format

```json
{ "type": "start" | "line" | "done" | "error", "data": "...", "exitCode": 0 }
```

### Terminal UI features

- macOS-style dark titlebar with traffic-light dots
- Blinking cursor, colour-coded lines (blue = command, green = success, red = error)
- Per-stream elapsed timer
- Exit code badge
- Post-stream card refresh via `GET /api/audit`
- Buttons: ▶ Audit · ⚡ Fix · 🔏 DBA · 🗄 Sandbox · ✕ Clear

---

## 6. Migration Sandbox

See [`scripts/migration-sandbox.js`](#scriptsmigration-sandboxjs) above.

### How the pre-flight integration works

When `runChecks()` executes Check 1 (rollback completeness), it:
1. Runs the fast file-existence check first (no deps).
2. Silences `process.stdout.write` and `console.log` temporarily.
3. Calls `runSandbox()` inline.
4. Restores stdout/console.
5. Maps any `broken` or `missingDown` entries to `CRITICAL / DB-ROLLBACK-BROKEN` findings.
6. If `better-sqlite3` is unavailable, emits `MEDIUM / DB-SANDBOX-ERROR` instead of crashing.

---

## 7. Release Notes Synthesizer

See [`scripts/generate-release-notes.js`](#scriptsgenerate-release-notesjs) above.

### Output document structure (`RELEASE_NOTES.md`)

| Section | Content |
|---|---|
| Status banner | `🔴 RELEASE BLOCKED` or `✅ RELEASE APPROVED` |
| 🛡️ Executive Release Summary | Version, branch, SHA, semver rec, confidence score, coverage |
| ⚠️ Breaking Changes & Deprecations | All `DB-DESTRUCTIVE`, `API-SCHEMA-*`, `API-METHOD-MISMATCH` findings |
| 🗄️ Database & Rollback Verification | Per-migration: operation type, dialect compatibility, sandbox status |
| 🔍 Full Findings Summary | Counts by severity |
| 🔒 Security & Middleware Audit | All `SEC-*` and `API-*` findings |
| 📦 Recent Commits | Last 10 commits with conventional-commit type classification |
| 📁 Files Modified | `git diff --name-only HEAD~1` |
| 🚀 Developer Action Items | Prioritised commands to unblock the release |

---

## 8. Finding IDs & Severity Reference

| ID | Severity | Domain | Description |
|---|---|---|---|
| `DB-ROLLBACK` | CRITICAL | Migration | `.down.sql` missing for a `.up.sql` migration |
| `DB-ROLLBACK-BROKEN` | CRITICAL | Migration | Sandbox dry-run: DOWN SQL fails at runtime |
| `DB-DESTRUCTIVE` | HIGH | Migration | `DROP COLUMN`, `RENAME COLUMN`, or `DROP TABLE` detected |
| `DB-NOT-NULL` | CRITICAL | Migration | `NOT NULL` column added without `DEFAULT` |
| `DB-SANDBOX-ERROR` | MEDIUM | Migration | Sandbox could not execute (e.g. `better-sqlite3` unavailable) |
| `SEC-ADMIN-AUTH` | CRITICAL | Security | Admin routes registered without auth middleware |
| `SEC-BULK-VALIDATION` | HIGH | Security | `POST /bulk` endpoint has no validation middleware |
| `API-SPEC-VERSION` | MEDIUM | API | OpenAPI version ≠ `package.json` version |
| `API-SCHEMA-DRIFT` | HIGH | API | `UserInput.required[]` references renamed field `name` |
| `API-SCHEMA-PRICE` | HIGH | API | `OrderInput.required[]` references dropped field `price` |
| `API-METHOD-MISMATCH` | HIGH | API | Spec documents `PATCH`, code uses `PUT` |
| `API-UNDOCUMENTED` | HIGH | API | Route exists in code but absent from `openapi.yaml` |
| `API-ADMIN-UNDOCUMENTED` | MEDIUM | API | Admin routes not in spec |
| `TST-MISSING` | HIGH/MEDIUM | Testing | No test file for a route module |

---

## 9. Configuration & Environment

| Variable / File | Purpose |
|---|---|
| `package.json` `version` | Source of truth for code version |
| `openapi.yaml` `info.version` | Checked against `package.json` for drift |
| `migrations/*.up.sql` | Forward migration scripts |
| `migrations/*.down.sql` | Rollback scripts (must exist 1:1 with `.up.sql`) |
| `src/routes/admin.js` | Inspected for auth middleware presence |
| `src/routes/orders.js` | Inspected for bulk endpoint validation |
| `tests/routes/<name>.test.js` | Expected test location per route file |
| `RELEASE_AUDIT.md` | Human-readable full audit report (served by dashboard) |
| `RELEASE_NOTES.md` | Generated by `generate-release-notes.js` |
| `PR_COMMENT.md` | Generated by `pr-commenter.js` |

---

## 10. Reproduction & Quick-Start

```bash
# Install dependencies (only needed once)
npm install

# Full pre-flight audit (read-only)
node scripts/pre-flight-check.js
# or
releaseguard audit

# Audit + auto-remediate fixable findings
releaseguard fix

# DBA sign-off for destructive migrations
releaseguard dba-signoff

# Migration dry-run sandbox
releaseguard verify-db

# Generate release notes
releaseguard notes

# Generate PR comment
releaseguard comment

# Launch real-time dashboard
releaseguard ui

# Run full test suite
npm test

# Run migration sandbox standalone
npm run test:sandbox

# Generate release notes via npm
npm run release-notes
```

---

*Documentation maintained by **ReleaseGuard AI** · `orders-api` v2.1.0*
