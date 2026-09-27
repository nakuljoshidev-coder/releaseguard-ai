# ReleaseGuard AI

> **Pre-Flight Release Auditor** — an AI-powered CLI + dashboard that runs security, database-migration, and API-contract audits before every production deploy.

![ReleaseGuard AI Dashboard](docs/ui-preview.png)

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Quick Start](#quick-start)
5. [CLI Usage](#cli-usage)
6. [Dashboard](#dashboard)
7. [Audit Domains](#audit-domains)
8. [Migration Safety](#migration-safety)
9. [Rollback Scripts](#rollback-scripts)
10. [Release Notes Synthesizer](#release-notes-synthesizer)
11. [Project Structure](#project-structure)
12. [Scripts Reference](#scripts-reference)
13. [Configuration](#configuration)
14. [Release History](#release-history)

---

## Overview

ReleaseGuard AI intercepts your CI/CD pipeline before a release reaches production. It spins up three independent audit engines in parallel, aggregates findings into a single risk score, auto-generates rollback SQL, and streams every result live to a terminal-style web dashboard.

If the risk score breaches your threshold, the release is **BLOCKED** and a PR comment is posted with the full findings report.

---

## Features

| Feature | Description |
|---|---|
| **Security & Middleware Audit** | Detects unauthenticated admin routes, missing rate-limiting, exposed system metrics |
| **DB Migration Safety** | Flags destructive SQL (`DROP COLUMN`, `RENAME COLUMN`, missing `.down.sql`) |
| **API Contract Drift** | Diffs `openapi.yaml` against live routes; catches breaking changes in "minor" releases |
| **SSE Live Terminal** | Streams audit output token-by-token to the dashboard in real time |
| **Auto Rollback Generation** | AI-writes `.down.sql` rollback scripts for every destructive migration |
| **DBA Sign-off Workflow** | One-click DBA approval gate inside the dashboard |
| **Migration Dry-Run Sandbox** | Runs migrations against an in-memory SQLite DB before touching production |
| **Release Notes Synthesizer** | Auto-generates `RELEASE_NOTES.md` from git diff + audit findings |
| **PR Comment Publisher** | Posts a structured audit report as a GitHub PR comment |
| **Risk Score Ring** | Visual 0–10 risk gauge with ELEVATED / CRITICAL / OK verdict |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  releaseguard CLI                   │
│              bin/releaseguard.js                    │
└────────────┬────────────┬────────────┬──────────────┘
             │            │            │
     ┌───────▼──┐  ┌──────▼──┐  ┌─────▼────────┐
     │ Security │  │   DB    │  │    API       │
     │  Audit   │  │ Safety  │  │  Contract    │
     │ Engine   │  │ Engine  │  │  Drift       │
     └───────┬──┘  └──────┬──┘  └─────┬────────┘
             │            │            │
             └────────────┼────────────┘
                          │
              ┌───────────▼───────────┐
              │   Risk Aggregator     │
              │  (score + verdict)    │
              └───────────┬───────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
  ┌───────▼────┐  ┌───────▼────┐  ┌──────▼──────┐
  │  Dashboard │  │  PR Comment│  │  RELEASE_   │
  │  SSE Feed  │  │  Publisher │  │  AUDIT.md   │
  └────────────┘  └────────────┘  └─────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- npm

### Install

```bash
git clone <repo-url>
cd orders-api
npm install
```

### Run a Full Audit

```bash
# via npm script
npm run simulate

# or via the CLI directly
node bin/releaseguard.js dba-signoff
```

### Launch the Dashboard

```bash
npm run dashboard
# → http://localhost:3000
```

---

## CLI Usage

```
releaseguard <command> [options]

Commands:
  audit           Run the full pre-flight audit suite
  dba-signoff     Run audit + open DBA approval workflow
  sandbox         Run migration dry-run in SQLite sandbox
  git-diff        Scan the current git diff for risky changes
  release-notes   Auto-generate RELEASE_NOTES.md from diff + findings

Options:
  --release <tag>   Target release tag (default: current package version)
  --threshold <n>   Risk score threshold that blocks the release (default: 7)
  --output <file>   Write audit report to file (default: RELEASE_AUDIT.md)
  --json            Output findings as JSON
```

---

## Dashboard

The web dashboard (`npm run dashboard`) provides:

- **Risk Score Ring** — animated gauge showing the 0–10 score and ELEVATED / CRITICAL / OK verdict
- **Domain Cards** — per-domain status chips (OK / WARN / CRIT) for Security, DB Safety, and API Drift
- **Live Terminal** — SSE-streamed console output, identical to what you'd see in CI
- **Action Buttons** — `Audit`, `Fix`, `DBA Sign-off`, `Sandbox`, `Clear`
- **Migration Inventory** — table of all migrations with rollback coverage and destructive flags
- **Rollback Accordion** — expandable view of auto-generated `.down.sql` scripts
- **RELEASE_AUDIT.md Preview** — rendered markdown of the full audit report

---

## Audit Domains

### Security & Middleware

Checks performed:

- Admin routes without authentication middleware
- Missing rate-limiting on public endpoints
- Unauthenticated endpoints exposing sensitive operations (DELETE user, purge orders, system metrics)
- Undocumented endpoints not present in `openapi.yaml`

### DB Migration Safety

Checks performed:

- `DROP COLUMN` — flags permanent data-loss risk
- `RENAME COLUMN` — flags broken queries and API contracts
- Missing `.down.sql` rollback counterpart
- Hard-delete patterns replacing soft-delete

### API Contract Drift

Checks performed:

- Routes present in code but absent from `openapi.yaml`
- Breaking changes (removed fields, changed types) in a minor/patch release
- Version mismatch between `package.json` and `openapi.yaml`

---

## Migration Safety

All migrations under `migrations/` are scanned before deploy. Each migration is rated:

| Risk Level | Criteria |
|---|---|
| `LOW` | Additive-only, has rollback |
| `HIGH` | Destructive SQL or missing rollback |
| `CRITICAL` | Irreversible data loss with no recovery path |

A migration is considered **destructive** if it contains any of:
`DROP TABLE`, `DROP COLUMN`, `RENAME COLUMN`, `TRUNCATE`, or `DELETE` without a `WHERE` clause.

---

## Rollback Scripts

ReleaseGuard AI auto-generates `.down.sql` rollback scripts for every destructive migration that is missing one. Scripts are written to the same `migrations/` directory and follow the naming convention:

```
<migration-name>.down.sql
```

Example auto-generated rollback:
```sql
-- Auto-generated rollback for 004_drop_price_from_orders.up.sql
-- WARNING: This restores the column structure but CANNOT recover lost data.
ALTER TABLE orders ADD COLUMN price NUMERIC(10,2);
```

---

## Release Notes Synthesizer

```bash
npm run release-notes
```

Reads the current git diff, cross-references audit findings, and writes `RELEASE_NOTES.md` with:

- Breaking changes extracted from the diff
- Security advisories from the audit
- Migration impact summary
- Rollback instructions

---

## Project Structure

```
orders-api/
├── bin/
│   └── releaseguard.js          # CLI entry point
├── dashboard/
│   ├── server.js                # Express + SSE server
│   └── public/
│       └── index.html           # Dashboard UI
├── docs/
│   └── ui-preview.png           # Dashboard screenshot
├── migrations/                  # SQL migration files + rollbacks
├── scripts/
│   ├── audit-runner.js          # Orchestrates all audit engines
│   ├── security-auditor.js      # Security & middleware checks
│   ├── db-migration-auditor.js  # DB safety checks
│   ├── api-contract-auditor.js  # OpenAPI drift checks
│   ├── auto-fixer.js            # Auto-remediation engine
│   ├── rollback-generator.js    # Rollback SQL writer
│   ├── pr-commenter.js          # GitHub PR comment publisher
│   ├── generate-release-notes.js
│   ├── migration-sandbox.js     # SQLite dry-run sandbox
│   ├── git-diff-scanner.js
│   └── simulate-pipeline.js
├── src/
│   ├── app.js
│   └── routes/
├── tests/
├── openapi.yaml
├── RELEASE_AUDIT.md             # Last audit report (auto-generated)
├── RELEASE_NOTES.md             # Last release notes (auto-generated)
└── package.json
```

---

## Scripts Reference

| Script | Command | Description |
|---|---|---|
| Start API server | `npm start` | Runs `src/app.js` |
| Run tests | `npm test` | Jest with coverage |
| Launch dashboard | `npm run dashboard` | Dashboard on port 3000 |
| Full audit simulation | `npm run simulate` | End-to-end pipeline run |
| Migration sandbox | `npm test:sandbox` | SQLite dry-run |
| Git diff scan | `npm run git-diff` | Scan current diff |
| Generate release notes | `npm run release-notes` | Write RELEASE_NOTES.md |
| Post PR comment | `npm run pr-comment` | Publish audit to GitHub PR |

---

## Configuration

Environment variables (`.env`):

```env
# Target release tag
RELEASE_TAG=v2.1.0

# Risk score threshold — releases above this are blocked
RISK_THRESHOLD=7

# GitHub PR comment (optional)
GITHUB_TOKEN=ghp_...
GITHUB_REPO=owner/repo
GITHUB_PR_NUMBER=42

# Dashboard port
PORT=3000
```

---

## Release History

### v2.1.0 _(current — audited, BLOCKED pending P0 fixes)_
- Added bulk order creation
- Added CSV export for orders
- Refactored user model (breaking: `username` column renamed)
- Dropped `price` column from orders table (data-loss risk)
- Added admin management routes (undocumented, unauthenticated)

### v2.0.0
- Initial public release
- Orders CRUD endpoints
- Users CRUD endpoints
- Products CRUD endpoints
- Pagination on `GET /api/v1/orders`
