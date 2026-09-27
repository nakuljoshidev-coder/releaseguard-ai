# 🛡️ ReleaseGuard AI — Pre-Flight Release Audit

> **Repository:** `playground`  
> **Audited Release:** `v2.1.0`  
> **Spec Version on File:** `v2.0.0` _(stale)_  
> **Audit Date:** _(auto-generated)_  
> **Auditor:** ReleaseGuard AI (automated)

---

## ⚠️ RELEASE VERDICT: **BLOCKED**

> Three independent audits returned **CRITICAL** findings across security, data integrity, and API compatibility.  
> This release **MUST NOT** be deployed to production until all P0 blockers are resolved.

---

## 1. Executive Risk Score

```
Overall Risk Score:  9 / 10  🔴  CRITICAL
```

| Dimension               | Score | Rationale |
|-------------------------|-------|-----------|
| **Security**            | 10/10 | 4 unauthenticated admin endpoints expose user deletion, order purge, and system metrics |
| **Data Integrity**      | 9/10  | `price` column permanently dropped with no rollback; hard-delete replaces soft-delete |
| **API Compatibility**   | 9/10  | 5 breaking changes in a "minor" release; 8 undocumented endpoints |
| **Rollback Safety**     | 8/10  | 2 of 5 migrations have no `.down.sql`; data cannot be recovered after migration 004 |
| **Test Coverage**       | 7/10  | 13 uncovered endpoints; new v2.1 features have zero automated tests |

**Risk rationale:** This release contains a cluster of critical-severity issues—any one of which could cause a production incident. The unauthenticated admin endpoints are an immediate security vulnerability that could result in data destruction by an unauthenticated caller. The column drop in migration 004 is irreversible without a database backup. Combined, these findings make the release unsafe to ship in its current state.

---

## 2. Breaking Changes Summary

The following changes break backwards compatibility with API v2.0 clients. None are documented in the OpenAPI spec.

### 2.1 API Contract Breaks

| # | Endpoint | Change | Severity | Client Impact |
|---|----------|--------|----------|---------------|
| BC-01 | `POST /api/v1/users` | Request schema changed: `{name, email}` → `{username, email, role}` | 🔴 CRITICAL | All existing user-creation clients will fail with validation error |
| BC-02 | `GET /api/v1/orders` | Pagination removed: `?page` and `?limit` params no longer respected | 🔴 CRITICAL | Paginated clients receive unbounded result set; potential OOM |
| BC-03 | `DELETE /api/v1/orders/:id` | Soft-delete replaced with hard-delete | 🔴 CRITICAL | Audit trail destroyed; deleted records are unrecoverable |
| BC-04 | `PATCH /api/v1/orders/:id` | HTTP method changed from `PATCH` to `PUT` | 🔴 HIGH | Clients sending `PATCH` receive `405 Method Not Allowed` |
| BC-05 | `DELETE /api/v1/users/:id` | Response status changed from `204 No Content` to `200 OK` with body | 🟡 MEDIUM | Strict REST clients may fail on unexpected response body |

### 2.2 Schema Breaks

| # | Resource | Change | Severity |
|---|----------|--------|----------|
| SC-01 | `User` | Field `name` renamed to `username`; field `role` added as required | 🔴 CRITICAL |
| SC-02 | `Order` | Field `price` removed from schema (column dropped in DB) | 🔴 CRITICAL |

### 2.3 Undocumented New Endpoints (v2.1)

These routes exist in code but are absent from `openapi.yaml`:

| Endpoint | Risk |
|----------|------|
| `POST /api/v1/orders/bulk` | Missing validation middleware; no spec entry |
| `GET /api/v1/orders/export/csv` | No spec entry; Content-Type behavior unknown |
| `GET /internal/admin/users` | 🔴 **No auth** — exposes full user list |
| `DELETE /internal/admin/users/:id` | 🔴 **No auth** — anyone can delete any user |
| `POST /internal/admin/orders/purge` | 🔴 **No auth** — anyone can destroy all order data |
| `GET /internal/admin/metrics` | No auth — exposes system internals |
| `GET /health` | Not in spec; exposes version string |
| `GET /api/v1/ping` | Deprecated endpoint not marked as deprecated in spec |

---

## 3. Security Findings

### SEC-01 — Unauthenticated Admin Endpoints 🔴 CRITICAL (BLOCK)

**File:** [`src/routes/admin.js`](src/routes/admin.js)

All four `/internal/admin/*` routes are registered with **zero middleware** — no authentication, no authorization, no rate-limiting. Any HTTP client can call these endpoints without credentials.

```
GET    /internal/admin/users         → Returns all users in the system
DELETE /internal/admin/users/:id     → Deletes any user by ID
POST   /internal/admin/orders/purge  → Purges ALL orders from the database
GET    /internal/admin/metrics       → Exposes uptime, version, internal stats
```

**Required fix:** Add authentication and role-based authorization middleware before this release ships. At minimum:
```js
router.use(requireAuth);
router.use(requireRole('admin'));
```

### SEC-02 — Bulk Orders Endpoint Missing Validation 🔴 HIGH

**File:** [`src/routes/orders.js`](src/routes/orders.js)

`POST /api/v1/orders` applies the `validateOrder` middleware. `POST /api/v1/orders/bulk` does **not**. Callers can bulk-insert orders with missing or invalid fields.

---

## 4. Database Migration Safety

### Migration Inventory

| Migration | Operation | Has Rollback | Risk |
|-----------|-----------|:------------:|------|
| `001_create_users_table` | CREATE TABLE users | ✅ Yes | Low |
| `002_create_orders_table` | CREATE TABLE orders | ✅ Yes | Low |
| `003_add_username_role_to_users` | RENAME COLUMN + ADD NOT NULL | ❌ **Missing** | 🔴 High |
| `004_drop_price_from_orders` | DROP COLUMN price | ❌ **Missing** | 🔴 Critical |
| `005_add_products_table` | CREATE TABLE products | ✅ Yes | Low |

### DB-01 — Irreversible Column Drop (Migration 004) 🔴 CRITICAL (BLOCK)

**File:** [`migrations/004_drop_price_from_orders.up.sql`](migrations/004_drop_price_from_orders.up.sql)

```sql
ALTER TABLE orders DROP COLUMN price;
```

- **No `.down.sql` exists.** Rollback requires a manual restore from database backup.
- All historical `price` data in the `orders` table is **permanently destroyed** when this migration runs.
- `orders.js` and `openapi.yaml` still expect `price` in `OrderInput` (spec mismatch).
- A rollback script has been auto-generated at [`migrations/004_drop_price_from_orders.down.sql`](migrations/004_drop_price_from_orders.down.sql) — note: it can restore the **column**, not the **data**.

### DB-02 — NOT NULL Column Without DEFAULT (Migration 003) 🔴 CRITICAL (BLOCK)

**File:** [`migrations/003_add_username_role_to_users.up.sql`](migrations/003_add_username_role_to_users.up.sql)

```sql
ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL;
```

Adding a `NOT NULL` column without a `DEFAULT` will **fail** if the `users` table contains any existing rows. Verify with:
```sql
SELECT COUNT(*) FROM users;  -- must be 0 before applying this migration
```

A rollback script has been auto-generated at [`migrations/003_add_username_role_to_users.down.sql`](migrations/003_add_username_role_to_users.down.sql).

### DB-03 — Column Rename Breaks API Contracts (Migration 003) 🔴 HIGH

`name` → `username` rename aligns with the new `UserController` but is a hard breaking change for any client or query that references the old column name. No backwards-compatibility alias or view was created.

---

## 5. Test Coverage Report

| Area | Status | Risk |
|------|--------|------|
| `POST /api/v1/users` — new schema | Minimal (happy path only) | 🔴 High |
| `PUT /api/v1/orders/:id` | **Zero coverage** | 🔴 High |
| `POST /api/v1/orders/bulk` | **Zero coverage** | 🔴 Critical |
| `GET /api/v1/orders/export/csv` | **Zero coverage** | 🔴 Critical |
| `GET /api/v1/users/:id` | **Zero coverage** | 🟡 Medium |
| `PATCH /api/v1/users/:id` | **Zero coverage** | 🟡 Medium |
| `POST /api/v1/products` | **Zero coverage** | 🟡 Medium |
| `PATCH /api/v1/products/:id` | **Zero coverage** | 🟡 Medium |
| All `/internal/admin/*` routes | **Zero coverage + no auth** | 🔴 Critical |
| `DELETE /api/v1/orders/:id` (hard-delete) | Minimal — only status code | 🔴 High |

**Endpoints with zero test coverage:** 13 of 17 implemented routes  
**New v2.1 features with zero tests:** 2 (bulk orders, CSV export)

---

## 6. Automated Rollback Verification Checklist

Use this checklist before **and** after deploying to confirm rollback readiness.

### Pre-Deployment

- [ ] **DB-001** Verify `003_add_username_role_to_users.down.sql` exists and is syntactically valid
- [ ] **DB-002** Verify `004_drop_price_from_orders.down.sql` exists (column restored; data loss is expected and accepted)
- [ ] **DB-003** Confirm a full database backup was taken immediately before running migrations
- [ ] **DB-004** Run `SELECT COUNT(*) FROM users WHERE role IS NULL;` — must return `0`
- [ ] **DB-005** Validate migration order: migrations must apply in numeric sequence (001 → 005)
- [ ] **DB-006** Test full rollback in staging: apply all migrations, then run all `.down.sql` in reverse order (005 → 001)
- [ ] **API-001** Confirm `openapi.yaml` version updated from `2.0.0` to `2.1.0`
- [ ] **API-002** All breaking changes (BC-01 through BC-05) documented in changelog and release notes
- [ ] **SEC-001** Authentication middleware applied to all `/internal/admin/*` routes
- [ ] **SEC-002** `validateOrder` middleware applied to `POST /api/v1/orders/bulk`
- [ ] **TST-001** Run `npm test` — all tests pass with exit code 0
- [ ] **TST-002** Run `node scripts/pre-flight-check.js` — automated pre-flight script returns no critical issues

### Post-Deployment Smoke Tests

- [ ] `GET /health` returns `{ status: "ok" }`
- [ ] `POST /api/v1/users` with `{username, email, role}` returns `201`
- [ ] `GET /api/v1/orders` returns HTTP 200 (verify no timeout on large datasets)
- [ ] `GET /internal/admin/users` without credentials returns `401`
- [ ] `POST /internal/admin/orders/purge` without credentials returns `401`
- [ ] Confirm database row counts match pre-deployment values for unaffected tables

---

## 7. Changelog — Release v2.1.0

> **⚠️ This is a breaking release.** Clients on v2.0 must migrate before upgrading.

### ✨ New Features
- `POST /api/v1/orders/bulk` — Create multiple orders in a single request
- `GET /api/v1/orders/export/csv` — Export all orders as a CSV file
- `GET /api/v1/products` + `GET /api/v1/products/:id` — Read products
- `POST /api/v1/products` + `PATCH /api/v1/products/:id` — Write products
- `GET /health` — Application health check endpoint

### 💥 Breaking Changes

**User API:**
- `POST /api/v1/users` — Request body schema changed.  
  _Before:_ `{ "name": "string", "email": "string" }`  
  _After:_ `{ "username": "string", "email": "string", "role": "string" }`

**Orders API:**
- `GET /api/v1/orders` — Pagination removed. All orders returned in single response. Query params `page` and `limit` are ignored.
- `PATCH /api/v1/orders/:id` — Method changed to `PUT`. Partial update no longer supported.
- `DELETE /api/v1/orders/:id` — Changed from soft-delete (`status: cancelled`) to hard-delete. Deleted orders are **permanently removed**.
- `GET /api/v1/orders/:id` — Response body no longer includes `price` field (column dropped from database).

**Order Schema:**
- Field `price` removed from `Order` and `OrderInput` objects.

### 🗄️ Database Migrations (v2.1.0)
| # | Migration | Type |
|---|-----------|------|
| 003 | Rename `users.name` → `users.username`; add `users.role NOT NULL` | ⚠️ Breaking |
| 004 | Drop `orders.price` column | ⚠️ Destructive |
| 005 | Create `products` table | Additive |

### 🔧 Internal Changes
- Admin endpoints added at `/internal/admin/*` _(pending auth implementation)_
- `DELETE /api/v1/users/:id` response changed from `204` to `200` with JSON body

### 🗑️ Deprecated
- `GET /api/v1/ping` — Deprecated; will be removed in v3.0

---

## 8. Recommended Actions Before Release

| Priority | Action | Owner |
|----------|--------|-------|
| 🔴 P0 | Add authentication + authorization to all `/internal/admin/*` routes | Security/Backend |
| 🔴 P0 | Create and test `003_add_username_role_to_users.down.sql` | DBA/Backend |
| 🔴 P0 | Create and test `004_drop_price_from_orders.down.sql`; archive `price` data | DBA/Backend |
| 🔴 P0 | Apply `validateOrder` middleware to `POST /api/v1/orders/bulk` | Backend |
| 🔴 P0 | Take verified database backup before running migrations | DBA/Ops |
| 🔴 P1 | Update `openapi.yaml` to v2.1.0 with all new endpoints and schema changes | Backend |
| 🔴 P1 | Write tests for bulk orders and CSV export endpoints | Backend/QA |
| 🟡 P2 | Publish migration guide for API v2.0 → v2.1 consumers | API/Docs |
| 🟡 P2 | Fix `DELETE /api/v1/users/:id` to return `204` per REST convention | Backend |
| 🟡 P2 | Add integer validation for `:id` parameters | Backend |
| 🟢 P3 | Mark `/api/v1/ping` as deprecated in spec and add sunset header | Backend |
| 🟢 P3 | Establish migration pairing policy (every `.up.sql` requires a `.down.sql`) | Process |

---

_Generated by **ReleaseGuard AI** — automated pre-flight release auditor_  
_Run `node scripts/pre-flight-check.js` to re-execute checks at any time._
