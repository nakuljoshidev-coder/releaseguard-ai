'use strict';
/**
 * ReleaseGuard AI — Git-Aware Diff Inspector
 *
 * Determines which files have changed relative to origin/main (or a fallback),
 * then returns a scoped file-set so pre-flight-check.js only analyses what
 * this PR/branch actually touched.
 *
 * Exported API:
 *   getDiffedFiles()  → { files, migrationFiles, routeFiles, schemaFiles, mode }
 *   scopeFindings(findings, diffedFiles) → filtered findings array
 *
 * Fallback chain:
 *   1. git diff --name-only origin/main...HEAD       (PR comparison)
 *   2. git diff --name-only HEAD~1...HEAD            (last commit)
 *   3. git diff --cached --name-only                 (staged files)
 *   4. git status --short (all modified/untracked)   (working tree)
 *   5. full scan (no git available)
 */

const { execSync }  = require('child_process');
const path          = require('path');
const fs            = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C  = (s) => `\x1b[36m${s}\x1b[0m`;
const DI = (s) => `\x1b[2m${s}\x1b[0m`;
const G  = (s) => `\x1b[32m${s}\x1b[0m`;
const Y  = (s) => `\x1b[33m${s}\x1b[0m`;
const BO = (s) => `\x1b[1m${s}\x1b[0m`;

// ─── git helpers ──────────────────────────────────────────────────────────────
function git(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch (_) {
    return null;
  }
}

function parseFilelist(raw) {
  if (!raw) return null;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return lines;
}

function parseStatusShort(raw) {
  if (!raw) return null;
  const lines = raw.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[?\sMADRCU]+/, '').trim())  // strip status letters
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

// ─── Categorise files ─────────────────────────────────────────────────────────
function categorise(files) {
  const migrationFiles = files.filter(f => /^migrations\//.test(f) && f.endsWith('.sql'));
  const routeFiles     = files.filter(f => /^src\/routes\//.test(f) && f.endsWith('.js'));
  const schemaFiles    = files.filter(f => f === 'openapi.yaml' || f.endsWith('.json') && /package/.test(f));
  const testFiles      = files.filter(f => /^tests\//.test(f) && f.endsWith('.js'));
  return { migrationFiles, routeFiles, schemaFiles, testFiles };
}

// ─── Primary export ───────────────────────────────────────────────────────────

/**
 * Detect changed files using the best available git strategy.
 *
 * @returns {{
 *   files: string[],
 *   migrationFiles: string[],
 *   routeFiles: string[],
 *   schemaFiles: string[],
 *   testFiles: string[],
 *   mode: string,
 *   isFull: boolean
 * }}
 */
function getDiffedFiles() {
  let files = null;
  let mode  = '';

  // Strategy 1: PR comparison against origin/main
  const s1 = parseFilelist(git('git diff --name-only origin/main...HEAD'));
  if (s1) { files = s1; mode = 'origin/main...HEAD'; }

  // Strategy 2: last commit diff
  if (!files) {
    const s2 = parseFilelist(git('git diff --name-only HEAD~1...HEAD'));
    if (s2) { files = s2; mode = 'HEAD~1...HEAD'; }
  }

  // Strategy 3: staged files
  if (!files) {
    const s3 = parseFilelist(git('git diff --cached --name-only'));
    if (s3) { files = s3; mode = 'staged (--cached)'; }
  }

  // Strategy 4: working tree
  if (!files) {
    const s4 = parseStatusShort(git('git status --short'));
    if (s4) { files = s4; mode = 'working tree'; }
  }

  // Strategy 5: full scan fallback
  if (!files || files.length === 0) {
    files = buildFullScan();
    mode  = 'full scan (no diff available)';
    return { files, ...categorise(files), mode, isFull: true };
  }

  return { files, ...categorise(files), mode, isFull: false };
}

/**
 * Build a full file list for fallback (all relevant source files).
 */
function buildFullScan() {
  const out = [];
  const dirs = ['migrations', 'src/routes', 'src/middleware', 'src/controllers'];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    fs.readdirSync(abs).forEach(f => {
      if (f.endsWith('.js') || f.endsWith('.sql')) out.push(`${dir}/${f}`);
    });
  }
  if (fs.existsSync(path.join(ROOT, 'openapi.yaml'))) out.push('openapi.yaml');
  if (fs.existsSync(path.join(ROOT, 'package.json'))) out.push('package.json');
  return out;
}

/**
 * Filter a findings array down to only those that reference files touched
 * by the current diff. Findings with no file association are always kept.
 *
 * @param {Array<{severity,id,title,detail,file}>} findings
 * @param {{ files: string[], isFull: boolean }} diffedFiles
 * @returns {Array}
 */
function scopeFindings(findings, diffedFiles) {
  if (diffedFiles.isFull) return findings;  // full scan — keep all
  const changed = new Set(diffedFiles.files);
  return findings.filter(f => {
    if (!f.file) return true;  // systemic findings (e.g. test coverage) always surface
    // normalise path separators
    const norm = f.file.replace(/\\/g, '/');
    return changed.has(norm);
  });
}

// ─── CLI entry point ───────────────────────────────────────────────────────────
/* istanbul ignore next */
if (require.main === module) {
  const { files, migrationFiles, routeFiles, schemaFiles, testFiles, mode, isFull } = getDiffedFiles();

  console.log(BO(`\n🔍  ReleaseGuard AI — Git Diff Scanner\n`));
  console.log(`  ${DI('Detection mode:')} ${C(mode)}`);
  console.log(`  ${DI('Total changed files:')} ${BO(String(files.length))}`);
  console.log();

  const groups = [
    { label: 'Migration files', items: migrationFiles, color: Y },
    { label: 'Route files',     items: routeFiles,     color: C },
    { label: 'Schema files',    items: schemaFiles,    color: G },
    { label: 'Test files',      items: testFiles,      color: DI },
  ];

  for (const { label, items, color } of groups) {
    if (items.length === 0) continue;
    console.log(`  ${BO(label)} (${items.length}):`);
    for (const f of items) console.log(`    ${color('→')} ${f}`);
    console.log();
  }

  const other = files.filter(f =>
    !migrationFiles.includes(f) && !routeFiles.includes(f) &&
    !schemaFiles.includes(f)   && !testFiles.includes(f)
  );
  if (other.length > 0) {
    console.log(`  ${BO('Other changed files')} (${other.length}):`);
    for (const f of other) console.log(`    ${DI('→')} ${f}`);
    console.log();
  }

  if (isFull) {
    console.log(`  ${Y('⚠  No git diff available — running full scan across all source files.')}\n`);
  } else {
    console.log(`  ${G('✔  Diff scope resolved. ReleaseGuard will target only these files.')}\n`);
  }
}

module.exports = { getDiffedFiles, scopeFindings };
