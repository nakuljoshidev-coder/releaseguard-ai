#!/usr/bin/env node
/**
 * ReleaseGuard AI — Migration Dry-Run Sandbox
 *
 * Executes every .up.sql migration against an in-memory SQLite database,
 * then immediately runs the corresponding .down.sql rollback.
 * Flags DB-ROLLBACK-BROKEN if any rollback fails or throws a syntax error.
 *
 * Usage:
 *   node scripts/migration-sandbox.js          # dry-run all migrations
 *   node scripts/migration-sandbox.js --json   # emit results as JSON to stdout
 *
 * Exit codes:
 *   0 — all up + down cycles passed
 *   1 — one or more rollbacks broke (DB-ROLLBACK-BROKEN flagged)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;

const ROOT      = path.resolve(__dirname, '..');
const MIG_DIR   = path.join(ROOT, 'migrations');
const JSON_MODE = process.argv.includes('--json');

// ─── SQLite compatibility shims ───────────────────────────────────────────────
// better-sqlite3 is synchronous; we adapt the SQL to SQLite dialect as needed.
// The real Postgres DDL uses SERIAL, NUMERIC, VARCHAR, REFERENCES, NOW() etc.
// SQLite is lenient with types but chokes on SERIAL and some PG-specific syntax.
function adaptForSQLite(sql) {
  return sql
    // SERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
    .replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    // TIMESTAMP DEFAULT NOW() → TEXT DEFAULT CURRENT_TIMESTAMP
    .replace(/\bTIMESTAMP\b/gi, 'TEXT')
    .replace(/\bNOW\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
    // NUMERIC(p,s) → REAL
    .replace(/\bNUMERIC\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'REAL')
    // DROP COLUMN IF EXISTS → DROP COLUMN (SQLite bundled in better-sqlite3 may not support IF EXISTS)
    .replace(/\bDROP\s+COLUMN\s+IF\s+EXISTS\s+/gi, 'DROP COLUMN ')
    // DROP TABLE IF EXISTS → keep as-is (SQLite supports this)
    // ALTER TABLE ... ALTER COLUMN ... DROP DEFAULT → skip (not supported in SQLite)
    .replace(/ALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+DROP\s+DEFAULT\s*;?/gi, '')
    // REFERENCES ... clause on column defs — keep as-is (SQLite parses but may ignore)
    ;
}

// ─── Load better-sqlite3 ──────────────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error(RED(BOLD('✖  better-sqlite3 is required but not installed.')));
  console.error(DIM('   Run: npm install --save-dev better-sqlite3'));
  process.exit(1);
}

// ─── Collect migration pairs ──────────────────────────────────────────────────
function collectMigrations() {
  if (!fs.existsSync(MIG_DIR)) return [];
  const files   = fs.readdirSync(MIG_DIR).sort();
  const upFiles = files.filter((f) => f.endsWith('.up.sql'));
  return upFiles.map((up) => ({
    name:     up.replace('.up.sql', ''),
    upFile:   path.join(MIG_DIR, up),
    downFile: path.join(MIG_DIR, up.replace('.up.sql', '.down.sql')),
    upSql:    fs.readFileSync(path.join(MIG_DIR, up), 'utf8'),
    downSql:  fs.existsSync(path.join(MIG_DIR, up.replace('.up.sql', '.down.sql')))
              ? fs.readFileSync(path.join(MIG_DIR, up.replace('.up.sql', '.down.sql')), 'utf8')
              : null,
  }));
}

// ─── Execute a block of SQL statements on the db ────────────────────────────
function execSql(db, sql, label) {
  // Strip SQL comments then split on semicolons
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const stmts = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    try {
      db.prepare(stmt).run();
    } catch (err) {
      throw new Error(`[${label}] Statement failed:\n  SQL: ${stmt.slice(0, 120)}\n  Error: ${err.message}`);
    }
  }
}

// ─── Run the full dry-run sandbox ─────────────────────────────────────────────
//
// Strategy:
//   For each migration N, spin up a fresh in-memory DB, apply migrations 1..N
//   (the forward pass), then execute migration N's .down.sql.  This isolates
//   every rollback test while ensuring the prerequisite schema is in place.
//
function runSandbox() {
  const migrations = collectMigrations();

  if (migrations.length === 0) {
    if (!JSON_MODE) console.log(YELLOW('  No migrations found in migrations/.'));
    return { passed: [], broken: [], missingDown: [] };
  }

  if (!JSON_MODE) {
    console.log(BOLD(`\n🔬  Migration Dry-Run Sandbox — ${migrations.length} migration(s) found\n`));
    console.log(DIM('  Each rollback test uses a fresh in-memory DB with all prerequisite UPs applied.\n'));
  }

  const passed      = [];
  const broken      = [];
  const missingDown = [];

  for (let i = 0; i < migrations.length; i++) {
    const mig   = migrations[i];
    const label = mig.name;

    // ── Spin up a fresh DB and apply migrations 0..i (forward pass) ──────────
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');

    let upError = null;
    for (let j = 0; j <= i; j++) {
      const sql = adaptForSQLite(migrations[j].upSql);
      try {
        execSql(db, sql, `${migrations[j].name}.up`);
      } catch (err) {
        upError = err.message;
        break;
      }
    }

    if (!JSON_MODE) process.stdout.write(`  ↑  ${CYAN(label)} … `);

    if (upError) {
      if (!JSON_MODE) console.log(RED(`FAIL\n     ${upError}`));
      db.close();
      broken.push({
        migration: label,
        direction: 'up',
        flag:      'DB-ROLLBACK-BROKEN',
        reason:    `UP migration failed in sandbox: ${upError}`,
      });
      continue;
    }

    if (!JSON_MODE) process.stdout.write(GREEN('OK  '));

    // ── Check DOWN exists ─────────────────────────────────────────────────────
    if (!mig.downSql) {
      if (!JSON_MODE) console.log(`↓  ${YELLOW('MISSING')}  ${DIM('(no .down.sql)')}`);
      db.close();
      missingDown.push({ migration: label, flag: 'DB-ROLLBACK-BROKEN', reason: 'No .down.sql file found.' });
      continue;
    }

    // ── Execute DOWN (rollback) on the fully-migrated DB ─────────────────────
    if (!JSON_MODE) process.stdout.write(`↓  ${CYAN(label)} … `);
    const downSqlAdapted = adaptForSQLite(mig.downSql);

    let downError = null;
    try {
      execSql(db, downSqlAdapted, `${label}.down`);
    } catch (err) {
      downError = err.message;
    }

    db.close();

    if (downError) {
      if (!JSON_MODE) console.log(RED(`FAIL\n     ${downError}`));
      broken.push({
        migration: label,
        direction: 'down',
        flag:      'DB-ROLLBACK-BROKEN',
        reason:    `Rollback (DOWN) failed in sandbox: ${downError}`,
      });
    } else {
      if (!JSON_MODE) console.log(GREEN('OK'));
      passed.push({ migration: label });
    }
  }

  if (!JSON_MODE) {
    console.log('\n' + '─'.repeat(60));
    const allBroken = [...broken, ...missingDown];
    if (allBroken.length === 0) {
      console.log(GREEN(BOLD(`  ✔  All ${passed.length} migration(s) passed up+down cycle.\n`)));
    } else {
      console.log(RED(BOLD(`  ✖  ${allBroken.length} migration(s) flagged DB-ROLLBACK-BROKEN:\n`)));
      for (const b of allBroken) {
        console.log(`     ${RED('✖')} ${CYAN(b.migration)}: ${b.reason}`);
      }
      console.log();
    }
    console.log('─'.repeat(60) + '\n');
  }

  return { passed, broken, missingDown };
}

// ─── Exports (for use by pre-flight-check.js) ─────────────────────────────────
module.exports = { runSandbox };

// ─── Main ─────────────────────────────────────────────────────────────────────
/* istanbul ignore next */
if (require.main === module) {
  const { passed, broken, missingDown } = runSandbox();

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ passed, broken, missingDown }, null, 2) + '\n');
  }

  const allBroken = [...broken, ...missingDown];
  process.exit(allBroken.length > 0 ? 1 : 0);
}
