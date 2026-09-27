'use strict';
/**
 * ReleaseGuard AI — PR Commenter
 *
 * Runs the pre-flight checks and formats all findings into GitHub-flavored
 * Markdown, suitable for posting as a pull request comment.
 *
 * Usage:
 *   node scripts/pr-commenter.js
 *
 * Output:
 *   - Prints markdown to stdout
 *   - Writes PR_COMMENT.md to the repository root
 */

const fs   = require('fs');
const path = require('path');

const { runChecks } = require('./pre-flight-check');

const ROOT    = path.resolve(__dirname, '..');
const OUTFILE = path.join(ROOT, 'PR_COMMENT.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function esc(s) {
  // Escape backticks inside inline code spans
  return String(s).replace(/`/g, "'");
}

// Map finding IDs to a short remediation hint for the PR comment
const REMEDIATION = {
  'SEC-ADMIN-AUTH':      'Run `node scripts/pre-flight-check.js --fix` to auto-inject `requireAuth` + `requireRole(\'admin\')` into `src/routes/admin.js`.',
  'SEC-BULK-VALIDATION': 'Add `validateBulkOrders` middleware to `router.post(\'/bulk\', ...)` in `src/routes/orders.js`.',
  'DB-ROLLBACK':         'Create the missing `.down.sql` rollback script before deploying.',
  'DB-DESTRUCTIVE':      'Verify a database backup exists. Once confirmed, run `node scripts/pre-flight-check.js --approve-db-risks` for DBA sign-off.',
  'DB-NOT-NULL':         'Add a `DEFAULT` value to the `NOT NULL` column, or confirm the table is empty before applying the migration.',
  'API-SPEC-VERSION':    'Run `node scripts/pre-flight-check.js --fix` to sync `openapi.yaml` version to match `package.json`.',
  'API-SCHEMA-DRIFT':    'Update `openapi.yaml` `UserInput` schema: rename `name` → `username`.',
  'API-SCHEMA-PRICE':    'Remove `price` from the `required` list in `openapi.yaml` `OrderInput` — column was dropped in migration 004.',
  'API-METHOD-MISMATCH': 'Run `node scripts/pre-flight-check.js --fix` to replace `patch:` with `put:` for `/api/v1/orders/{id}` in `openapi.yaml`.',
  'API-UNDOCUMENTED':    'Add the endpoint definition to `openapi.yaml` or remove the route from the codebase.',
  'API-ADMIN-UNDOCUMENTED': 'Document internal admin routes in a separate internal spec, or ensure they are network-restricted.',
  'TST-MISSING':         'Run `node scripts/pre-flight-check.js --fix` to auto-generate a boilerplate test file.',
};

// ─── Build the markdown ───────────────────────────────────────────────────────

function buildComment(findings) {
  const pkg     = JSON.parse(read('package.json') || '{}');
  const version = pkg.version || '?';

  const critical     = findings.filter(f => f.severity === 'CRITICAL');
  const high         = findings.filter(f => f.severity === 'HIGH');
  const medium       = findings.filter(f => f.severity === 'MEDIUM');
  const acknowledged = findings.filter(f => f.severity === 'ACKNOWLEDGED');

  const isBlocked = critical.length > 0 || high.length > 0;
  const riskScore = Math.min(10, 3 + (critical.length * 3 + high.length * 1.5 + medium.length * 0.5) | 0);

  const statusBadge = isBlocked
    ? '## 🔴 RELEASE BLOCKED'
    : '## 🟢 RELEASE READY';

  const statusLine = isBlocked
    ? `> **${critical.length} critical** and **${high.length} high-severity** issues must be resolved before this PR can merge.`
    : medium.length > 0
      ? '> No blocking issues. Review the operational warnings below before deploying.'
      : '> All pre-flight checks passed. This release is safe to deploy.';

  // ── Risk score table ────────────────────────────────────────────────────────
  const scoreEmoji = riskScore >= 8 ? '🔴' : riskScore >= 5 ? '🟡' : '🟢';
  const riskTable = [
    '### 📊 Executive Risk Score',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Overall Risk Score** | ${scoreEmoji} **${riskScore} / 10** |`,
    `| Release version | \`v${version}\` |`,
    `| Critical findings | ${critical.length} |`,
    `| High findings | ${high.length} |`,
    `| Medium findings | ${medium.length} |`,
    `| Acknowledged (DBA sign-off) | ${acknowledged.length} |`,
  ].join('\n');

  // ── Section builder ─────────────────────────────────────────────────────────
  function section(emoji, title, items, rowFn) {
    if (items.length === 0) return '';
    const rows = items.map(rowFn).join('\n');
    return [
      `<details>`,
      `<summary>${emoji} <strong>${title}</strong> (${items.length})</summary>`,
      ``,
      rows,
      ``,
      `</details>`,
    ].join('\n');
  }

  function findingRow(f) {
    const file   = f.file ? `\`${f.file}\`` : '—';
    const hint   = REMEDIATION[f.id] || '_No automated fix available — manual review required._';
    return [
      `---`,
      `**[\`${f.id}\`]** ${f.title}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **File** | ${file} |`,
      `| **Detail** | ${esc(f.detail)} |`,
      `| **Remediation** | ${hint} |`,
    ].join('\n');
  }

  function dbRow(f) {
    const upFile   = f.file ? path.basename(f.file) : null;
    const downFile = upFile ? upFile.replace('.up.sql', '.down.sql') : null;
    const rollback = downFile && fs.existsSync(path.join(ROOT, 'migrations', downFile))
      ? `✅ Auto-generated → \`migrations/${downFile}\``
      : `❌ Missing — run \`node scripts/pre-flight-check.js\` to generate`;
    return [
      `---`,
      `**[\`${f.id}\`]** ${f.title}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Migration** | \`${f.file || '—'}\` |`,
      `| **Rollback script** | ${rollback} |`,
      `| **Action** | ${REMEDIATION['DB-DESTRUCTIVE']} |`,
    ].join('\n');
  }

  function apiRow(f) {
    return [
      `---`,
      `**[\`${f.id}\`]** ${f.title}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **File** | \`${f.file || '—'}\` |`,
      `| **Detail** | ${esc(f.detail)} |`,
      `| **Fix** | ${REMEDIATION[f.id] || '_Manual review required._'} |`,
    ].join('\n');
  }

  // Categorise findings by section
  const blocking    = findings.filter(f => f.severity === 'CRITICAL' || (f.severity === 'HIGH' && f.id !== 'DB-DESTRUCTIVE'));
  const dbWarnings  = findings.filter(f => f.id === 'DB-DESTRUCTIVE');
  const apiDrift    = findings.filter(f => ['API-SPEC-VERSION','API-SCHEMA-DRIFT','API-SCHEMA-PRICE','API-METHOD-MISMATCH','API-UNDOCUMENTED','API-ADMIN-UNDOCUMENTED'].includes(f.id));

  const blockingSection = section('🚨', 'Blocking Issues',               blocking,   findingRow);
  const dbSection       = section('⚠️',  'Operational Warnings — DB Migrations', dbWarnings, dbRow);
  const apiSection      = section('📝', 'API Drift & Spec Discrepancies', apiDrift,   apiRow);

  // ── Quick action guide ──────────────────────────────────────────────────────
  const quickActions = [
    '### ⚡ Quick Action Guide',
    '',
    '| Situation | Command |',
    '|-----------|---------|',
    '| Auto-fix security, spec version, and test stubs | `node scripts/pre-flight-check.js --fix` |',
    '| DBA has verified backups & rollback scripts | `node scripts/pre-flight-check.js --approve-db-risks` |',
    '| Re-run full audit after making changes | `node scripts/pre-flight-check.js` |',
    '| Generate this PR comment again | `npm run pr-comment` |',
    '',
    '> **Rollback scripts** for destructive migrations are auto-generated in `migrations/`.',
    '> Review them before applying to production.',
  ].join('\n');

  // ── Footer ──────────────────────────────────────────────────────────────────
  const footer = [
    '---',
    `<sub>Generated by **ReleaseGuard AI** · \`v${version}\` · ${new Date().toUTCString()}</sub>`,
  ].join('\n');

  // ── Assemble ────────────────────────────────────────────────────────────────
  const parts = [
    statusBadge,
    '',
    statusLine,
    '',
    riskTable,
    '',
    blockingSection,
    dbSection,
    apiSection,
    '',
    quickActions,
    '',
    footer,
  ].filter(p => p !== null && p !== undefined);

  return parts.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const findings = runChecks();
const markdown  = buildComment(findings);

// Write to file
fs.writeFileSync(OUTFILE, markdown, 'utf8');

// Print to stdout
process.stdout.write(markdown + '\n');
process.stderr.write(`\n✔  PR_COMMENT.md written to ${OUTFILE}\n`);
