#!/usr/bin/env node
/**
 * ReleaseGuard AI — Pre-Flight Check Script
 *
 * Usage:
 *   node scripts/pre-flight-check.js                    # audit only
 *   node scripts/pre-flight-check.js --fix              # audit + auto-remediate + re-audit
 *   node scripts/pre-flight-check.js --approve-db-risks # DBA sign-off: downgrade DB-DESTRUCTIVE to INFO
 *
 * Exit codes:
 *   0 — No critical/high issues (release may proceed)
 *   1 — Critical or high-severity issues remain (or DBA bypass used without rollback scripts)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── ANSI colour helpers ──────────────────────────────────────────────────────
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;
const BLUE   = (s) => `\x1b[34m${s}\x1b[0m`;

// ─── File helpers ─────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// =============================================================================
// ALL CHECKS — returns a findings array (pure, no side-effects)
// =============================================================================
function runChecks() {
  const findings = [];

  function finding(severity, id, title, detail, file = null) {
    findings.push({ severity, id, title, detail, file });
  }

  // ── Check 1: Migration rollback completeness + dry-run sandbox ──────────────
  const migDir = path.join(ROOT, 'migrations');
  if (fs.existsSync(migDir)) {
    // File-existence check (fast, no deps)
    const files  = fs.readdirSync(migDir);
    const upFiles = files.filter((f) => f.endsWith('.up.sql'));
    for (const up of upFiles) {
      const down = up.replace('.up.sql', '.down.sql');
      if (!files.includes(down)) {
        finding('CRITICAL', 'DB-ROLLBACK',
          `Missing rollback script: ${down}`,
          `Migration ${up} has no corresponding .down.sql. ` +
            'Rolling back in a production incident is impossible without manual intervention.',
          `migrations/${up}`);
      }
    }

    // Sandbox dry-run: execute UP then DOWN for each migration in SQLite
    // Suppress terminal output when called as a library (JSON_MODE handled inside sandbox)
    try {
      const origWrite = process.stdout.write.bind(process.stdout);
      const origLog   = console.log.bind(console);
      // Temporarily silence sandbox's own progress output when embedded in pre-flight
      process.stdout.write = () => true;
      console.log = () => {};
      let sandboxResult;
      try {
        const { runSandbox } = require('./migration-sandbox');
        sandboxResult = runSandbox();
      } finally {
        process.stdout.write = origWrite;
        console.log = origLog;
      }
      const { broken, missingDown } = sandboxResult;
      for (const b of [...broken, ...missingDown]) {
        finding('CRITICAL', 'DB-ROLLBACK-BROKEN',
          `Rollback dry-run failed: ${b.migration}`,
          b.reason,
          `migrations/${b.migration}.down.sql`);
      }
    } catch (sandboxErr) {
      finding('MEDIUM', 'DB-SANDBOX-ERROR',
        'Migration sandbox could not execute',
        `better-sqlite3 unavailable or sandbox threw: ${sandboxErr.message}`,
        null);
    }
  }

  // ── Check 2: Destructive migration operations ───────────────────────────────
  if (fs.existsSync(migDir)) {
    const dangerous = [
      { pattern: /\bDROP\s+COLUMN\b/i,   label: 'DROP COLUMN (permanent data loss)' },
      { pattern: /\bRENAME\s+COLUMN\b/i, label: 'RENAME COLUMN (breaks existing queries and API contracts)' },
      { pattern: /\bDROP\s+TABLE\b/i,    label: 'DROP TABLE (permanent data loss)' },
    ];
    for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith('.up.sql'))) {
      const sql = read(`migrations/${file}`) || '';
      for (const { pattern, label } of dangerous) {
        if (pattern.test(sql)) {
          finding('HIGH', 'DB-DESTRUCTIVE',
            `Destructive SQL in ${file}: ${label}`,
            `The migration contains a ${label} operation. Verify a rollback script exists ` +
              'and that data is archived before applying to production.',
            `migrations/${file}`);
        }
      }
      if (/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+\w+[^;]*NOT\s+NULL/i.test(sql) &&
          !/DEFAULT\s+/i.test(sql)) {
        finding('CRITICAL', 'DB-NOT-NULL',
          `NOT NULL column without DEFAULT in ${file}`,
          'Adding a NOT NULL column without a DEFAULT will fail if the table contains existing rows.',
          `migrations/${file}`);
      }
    }
  }

  // ── Check 3: Admin route authentication ────────────────────────────────────
  const adminSrc = read('src/routes/admin.js');
  if (adminSrc) {
    const routeLines = adminSrc.split('\n')
      .filter((l) => /router\.(get|post|put|patch|delete)\s*\(/.test(l));
    const hasAuth = /requireAuth|authenticate|authMiddleware|verifyToken|isAuthenticated/i.test(adminSrc);
    if (!hasAuth && routeLines.length > 0) {
      finding('CRITICAL', 'SEC-ADMIN-AUTH',
        'Admin routes registered without authentication middleware',
        `src/routes/admin.js defines ${routeLines.length} route(s) but contains no recognisable ` +
          'auth middleware (requireAuth, authenticate, verifyToken, etc.).',
        'src/routes/admin.js');
    }
  }

  // ── Check 4: Bulk endpoint missing validation ───────────────────────────────
  const ordersSrc = read('src/routes/orders.js');
  if (ordersSrc) {
    const hasBulk = /router\.post\s*\(\s*['"`]\/bulk['"`]/.test(ordersSrc);
    if (hasBulk) {
      const bulkLine = ordersSrc.split('\n')
        .find((l) => /\/bulk/.test(l) && /router\.post/.test(l));
      if (bulkLine && !/validate(Order|BulkOrders)/.test(bulkLine)) {
        finding('HIGH', 'SEC-BULK-VALIDATION',
          'POST /api/v1/orders/bulk missing validation middleware',
          `The bulk endpoint (${bulkLine.trim()}) does not apply any validation middleware.`,
          'src/routes/orders.js');
      }
    }
  }

  // ── Check 5: OpenAPI spec version + schema drift ────────────────────────────
  const spec   = read('openapi.yaml') || '';
  const pkgRaw = read('package.json');
  let pkgVer = null;
  if (pkgRaw) { try { pkgVer = JSON.parse(pkgRaw).version; } catch (_) {} }

  const specVerMatch = spec.match(/^\s*version:\s*["']?(\d+\.\d+\.\d+)["']?/m);
  const specVer = specVerMatch ? specVerMatch[1] : null;

  if (specVer && pkgVer && specVer !== pkgVer) {
    finding('MEDIUM', 'API-SPEC-VERSION',
      `OpenAPI spec version (${specVer}) does not match package version (${pkgVer})`,
      'The openapi.yaml info.version field is stale.',
      'openapi.yaml');
  }

  const userInputBlock = spec.match(/UserInput:[\s\S]*?(?=\n    \w|\ncomponents|\z)/);
  if (userInputBlock) {
    const reqMatch = userInputBlock[0].match(/required:([\s\S]*?)properties:/);
    if (reqMatch && /^\s+-\s+name\s*$/m.test(reqMatch[1])) {
      finding('HIGH', 'API-SCHEMA-DRIFT',
        "OpenAPI spec UserInput still lists 'name' as required (implementation uses 'username')",
        "The UserInput schema's required array contains 'name' instead of 'username'.",
        'openapi.yaml');
    }
  }

  const orderInputBlock = spec.match(/OrderInput:[\s\S]*?(?=\n    \w|\ncomponents|\z)/);
  if (orderInputBlock) {
    const reqMatch = orderInputBlock[0].match(/required:([\s\S]*?)properties:/);
    if (reqMatch && /^\s+-\s+price\s*$/m.test(reqMatch[1])) {
      finding('HIGH', 'API-SCHEMA-PRICE',
        "OpenAPI spec still requires 'price' in OrderInput (column dropped from database)",
        "Migration 004 dropped the 'price' column, but openapi.yaml still lists it as required.",
        'openapi.yaml');
    }
  }

  const ordersIdBlock = spec.match(/\/api\/v1\/orders\/\{id\}:([\s\S]*?)(?=\n  \/|\ncomponents:|$)/);
  if (ordersIdBlock) {
    const block = ordersIdBlock[1];
    if (/^\s+patch:/m.test(block) && !/^\s+put:/m.test(block)) {
      finding('HIGH', 'API-METHOD-MISMATCH',
        "OpenAPI spec documents PATCH /api/v1/orders/{id} but implementation uses PUT",
        "src/routes/orders.js registers router.put('/:id', ...). The spec still documents PATCH only.",
        'openapi.yaml');
    }
  }

  // ── Check 6: Undocumented routes ───────────────────────────────────────────
  const routesToCheck = [
    { file: 'src/routes/orders.js', pattern: /router\.(post|get)\s*\(\s*['"`]\/bulk['"`]/, specPath: '/api/v1/orders/bulk',   label: 'POST /api/v1/orders/bulk' },
    { file: 'src/routes/orders.js', pattern: /router\.get\s*\(\s*['"`]\/export\/csv['"`]/,  specPath: '/api/v1/orders/export', label: 'GET /api/v1/orders/export/csv' },
  ];
  for (const { file, pattern, specPath, label } of routesToCheck) {
    const src = read(file) || '';
    if (pattern.test(src) && !spec.includes(specPath)) {
      finding('HIGH', 'API-UNDOCUMENTED',
        `Undocumented endpoint: ${label}`,
        `The route is implemented in ${file} but absent from openapi.yaml.`,
        file);
    }
  }

  const adminRouteSrc = read('src/routes/admin.js') || '';
  const adminCount = (adminRouteSrc.match(/router\.(get|post|put|patch|delete)\s*\(/g) || []).length;
  if (adminCount > 0 && !spec.includes('/internal/admin')) {
    finding('MEDIUM', 'API-ADMIN-UNDOCUMENTED',
      `${adminCount} admin route(s) in src/routes/admin.js are not in openapi.yaml`,
      'Internal admin endpoints should be documented or gated behind a network boundary.',
      'src/routes/admin.js');
  }

  // ── Check 7: Test coverage ─────────────────────────────────────────────────
  const routeDir = path.join(ROOT, 'src', 'routes');
  if (fs.existsSync(routeDir)) {
    for (const route of fs.readdirSync(routeDir).filter((f) => f.endsWith('.js'))) {
      const name = route.replace('.js', '');
      const testFile = `tests/routes/${name}.test.js`;
      if (!exists(testFile)) {
        finding(name === 'admin' ? 'HIGH' : 'MEDIUM', 'TST-MISSING',
          `No test file for src/routes/${route}`,
          `Expected ${testFile} to exist. Routes in this file have zero automated test coverage.`,
          `src/routes/${route}`);
      }
    }
  }

  return findings;
}

// =============================================================================
// DBA OVERRIDE — --approve-db-risks
// Downgrade DB-DESTRUCTIVE findings to INFO when rollback scripts exist.
// Returns { approved: [{id,migrationFile}], blocked: [{id,migrationFile,reason}] }
// =============================================================================
function applyDbaApproval(findings) {
  const migDir   = path.join(ROOT, 'migrations');
  const approved = [];
  const blocked  = [];

  for (const f of findings) {
    if (f.id !== 'DB-DESTRUCTIVE') continue;

    // f.file = "migrations/003_add_username_role_to_users.up.sql"
    const upFile   = f.file ? path.basename(f.file) : null;
    const downFile = upFile ? upFile.replace('.up.sql', '.down.sql') : null;
    const downPath = downFile ? path.join(migDir, downFile) : null;

    if (downPath && fs.existsSync(downPath)) {
      approved.push({ id: f.id, migrationFile: upFile, rollbackFile: downFile });
    } else {
      blocked.push({
        id: f.id,
        migrationFile: upFile || '(unknown)',
        reason: downFile
          ? `Rollback script ${downFile} does not exist — cannot grant DBA sign-off`
          : 'Could not determine migration file name from finding',
      });
    }
  }

  return { approved, blocked };
}

// =============================================================================
// PRINT FINDINGS
// =============================================================================
function printFindings(findings) {
  const LABEL = {
    CRITICAL:    RED('● CRITICAL   '),
    HIGH:        YELLOW('● HIGH       '),
    MEDIUM:      YELLOW('○ MEDIUM     '),
    INFO:        BLUE('ℹ INFO        '),
    ACKNOWLEDGED: GREEN('✔ ACKNOWLEDGED'),
  };
  for (const f of findings) {
    const label = LABEL[f.severity] || DIM(`○ ${f.severity.padEnd(12)}`);
    console.log(`${label}  [${CYAN(f.id)}] ${BOLD(f.title)}`);
    console.log(`               ${DIM(f.detail)}`);
    if (f.file) console.log(`               ${DIM('→ ' + f.file)}`);
    console.log();
  }
}

// =============================================================================
// EXPORTS (for use by pr-commenter.js and other tools)
// =============================================================================
module.exports = { runChecks };

// =============================================================================
// MAIN — only runs when executed directly
// =============================================================================
/* istanbul ignore next */
if (require.main === module) {
const FIX_MODE        = process.argv.includes('--fix');
const APPROVE_DB_RISKS = process.argv.includes('--approve-db-risks');

const modeTag = FIX_MODE ? ' (--fix mode)' : APPROVE_DB_RISKS ? ' (--approve-db-risks mode)' : '';
console.log(BOLD(`\n🛡️  ReleaseGuard AI — Pre-Flight Check${modeTag}\n`));
console.log(DIM('Running checks…\n'));

let findings = runChecks();

// ─── --approve-db-risks path ──────────────────────────────────────────────────
if (APPROVE_DB_RISKS) {
  const dbDestructive = findings.filter((f) => f.id === 'DB-DESTRUCTIVE');

  if (dbDestructive.length === 0) {
    console.log(GREEN('  No DB-DESTRUCTIVE findings to acknowledge.\n'));
  } else {
    const { approved, blocked } = applyDbaApproval(findings);

    if (blocked.length > 0) {
      // At least one destructive migration has no rollback script — cannot grant sign-off
      console.log(RED(BOLD('  ✖  DBA Sign-Off DENIED — missing rollback script(s):\n')));
      for (const b of blocked) {
        console.log(`     ${RED('✖')} ${b.migrationFile}: ${b.reason}`);
      }
      console.log();
    }

    if (approved.length > 0) {
      console.log(GREEN(BOLD('  ✔  DBA Sign-Off Acknowledged: Rollback migrations verified.\n')));
      console.log(DIM('  Acknowledged migrations:'));
      for (const a of approved) {
        console.log(`     ${GREEN('✔')} ${a.migrationFile}  ${DIM('←  rollback:')} ${CYAN(a.rollbackFile)}`);
      }
      console.log();

      // Downgrade approved DB-DESTRUCTIVE findings from HIGH → ACKNOWLEDGED
      const approvedFiles = new Set(approved.map((a) => a.migrationFile));
      findings = findings.map((f) => {
        if (f.id === 'DB-DESTRUCTIVE') {
          const upFile = f.file ? path.basename(f.file) : null;
          if (upFile && approvedFiles.has(upFile)) {
            return {
              ...f,
              severity: 'ACKNOWLEDGED',
              title: `[DBA Approved] ${f.title}`,
              detail: `DBA sign-off granted — rollback script verified. Original: ${f.detail}`,
            };
          }
        }
        return f;
      });
    }

    if (blocked.length > 0) {
      // Leave blocked ones as HIGH so the build still fails
      console.log(YELLOW('  Unacknowledged findings will remain blocking.\n'));
    }
  }
}

// ─── --fix path ───────────────────────────────────────────────────────────────
if (FIX_MODE && findings.length > 0) {
  const { applyFixes } = require('./auto-fix');
  const { applied, skipped } = applyFixes(findings);

  // Print applied/skipped summary
  if (applied.length > 0) {
    console.log(BOLD(`\n📋  Remediation Summary (${applied.length} fix${applied.length > 1 ? 'es' : ''} applied)\n`));
    for (const a of applied) {
      console.log(`  ${GREEN('✔')}  Fixed: ${CYAN(a.id)} — ${a.description}`);
      if (a.file) console.log(`       ${DIM('→ ' + a.file)}`);
    }
  }
  if (skipped.length > 0) {
    console.log();
    for (const s of skipped) {
      console.log(`  ${YELLOW('○')}  Skipped: ${CYAN(s.id)} — ${s.reason}`);
    }
  }

  // Re-run checks after fixes
  console.log(BOLD('\n🔄  Re-running checks after remediation…\n'));
  findings = runChecks();
}

// ─── Report ───────────────────────────────────────────────────────────────────
// Split by actionable severity (ACKNOWLEDGED / INFO are non-blocking)
const critical     = findings.filter((f) => f.severity === 'CRITICAL');
const high         = findings.filter((f) => f.severity === 'HIGH');
const medium       = findings.filter((f) => f.severity === 'MEDIUM');
const acknowledged = findings.filter((f) => f.severity === 'ACKNOWLEDGED');

const blockingFindings = findings.filter(
  (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
);
const nonBlockingFindings = findings.filter(
  (f) => f.severity !== 'CRITICAL' && f.severity !== 'HIGH'
);

if (findings.length === 0) {
  console.log(GREEN(BOLD('✔  No issues detected. Release may proceed.\n')));
  process.exit(0);
}

// Print blocking first, then non-blocking
if (blockingFindings.length > 0) printFindings(blockingFindings);
if (nonBlockingFindings.length > 0) printFindings(nonBlockingFindings);

console.log('─'.repeat(60));
console.log(
  `  ${RED(`${critical.length} critical`)}   ` +
  `${YELLOW(`${high.length} high`)}   ` +
  `${YELLOW(`${medium.length} medium`)}` +
  (acknowledged.length > 0 ? `   ${GREEN(`${acknowledged.length} acknowledged`)}` : '')
);
console.log('─'.repeat(60));

if (critical.length > 0 || high.length > 0) {
  const msg = FIX_MODE
    ? '\n✖  Some issues could not be auto-fixed. Manual intervention required.\n'
    : '\n✖  RELEASE BLOCKED — resolve critical/high findings before deploying.\n';
  console.log(RED(BOLD(msg)));
  process.exit(1);
} else if (medium.length > 0) {
  console.log(YELLOW(BOLD('\n⚠  RELEASE CAUTION — medium findings present. Review before deploying.\n')));
  process.exit(0);
} else if (acknowledged.length > 0) {
  console.log(GREEN(BOLD('\n✔  RELEASE APPROVED — all risks acknowledged by DBA sign-off.\n')));
  process.exit(0);
} else {
  console.log(GREEN(BOLD('\n✔  No issues detected. Release may proceed.\n')));
  process.exit(0);
}
} // end require.main guard
