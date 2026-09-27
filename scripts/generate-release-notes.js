#!/usr/bin/env node
/**
 * ReleaseGuard AI — Autonomous Release Notes & Executive Changelog Synthesizer
 *
 * Pipeline:
 *   1. Git context  — commit log, modified files, last tag
 *   2. Security     — runChecks() from pre-flight-check.js
 *   3. Sandbox      — runSandbox() from migration-sandbox.js
 *   4. Semver rec   — MAJOR / MINOR / PATCH based on findings + git diff
 *   5. Score        — Production Release Readiness Score (0–100)
 *   6. Output       — RELEASE_NOTES.md + optional --json to stdout
 *
 * Usage:
 *   node scripts/generate-release-notes.js         # writes RELEASE_NOTES.md
 *   node scripts/generate-release-notes.js --json  # also prints raw JSON metadata
 *   node scripts/generate-release-notes.js --dry   # print only, no file write
 *
 * Exit codes:
 *   0 — notes generated (may still contain blocking findings)
 *   1 — fatal error during generation
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const ROOT      = path.resolve(__dirname, '..');
const OUT_FILE  = path.join(ROOT, 'RELEASE_NOTES.md');
const JSON_MODE = process.argv.includes('--json');
const DRY_RUN   = process.argv.includes('--dry');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;

// ─── Utility ──────────────────────────────────────────────────────────────────
function read(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function git(cmd, fallback = '') {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (_) {
    return fallback;
  }
}

// ─── 1. GIT CONTEXT ───────────────────────────────────────────────────────────
function collectGitContext() {
  const lastTag    = git('git describe --tags --abbrev=0', '');
  const branch     = git('git rev-parse --abbrev-ref HEAD', 'unknown');
  const headSha    = git('git rev-parse --short HEAD', 'unknown');
  const commitLog  = git('git log -n 10 --oneline', '(no commits)');
  const diffFiles  = git('git diff --name-only HEAD~1', '');
  const modifiedFiles = diffFiles ? diffFiles.split('\n').filter(Boolean) : [];

  // Classify commits by conventional-commit prefix
  const commits = commitLog.split('\n').filter(Boolean).map(line => {
    const m = line.match(/^([0-9a-f]+)\s+(.*)$/);
    if (!m) return { sha: '?', msg: line, type: 'other' };
    const msg  = m[2];
    const type = /^feat(\(|!|:)/i.test(msg)  ? 'feat'
               : /^fix(\(|!|:)/i.test(msg)   ? 'fix'
               : /^docs(\(|!|:)/i.test(msg)  ? 'docs'
               : /^test(\(|!|:)/i.test(msg)  ? 'test'
               : /^chore(\(|!|:)/i.test(msg) ? 'chore'
               : /^refactor/i.test(msg)      ? 'refactor'
               : /BREAKING/i.test(msg)       ? 'breaking'
               : 'other';
    return { sha: m[1], msg, type };
  });

  return { lastTag, branch, headSha, commits, modifiedFiles };
}

// ─── 2. SECURITY & DRIFT FINDINGS ────────────────────────────────────────────
function collectFindings() {
  // Silence sandbox's own console output when called as library
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog   = console.log.bind(console);
  process.stdout.write = () => true;
  console.log = () => {};
  let findings = [];
  try {
    const { runChecks } = require('./pre-flight-check');
    findings = runChecks();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return findings;
}

// ─── 3. SANDBOX MIGRATION STATE ───────────────────────────────────────────────
function collectSandboxResults() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog   = console.log.bind(console);
  process.stdout.write = () => true;
  console.log = () => {};
  let result = { passed: [], broken: [], missingDown: [] };
  try {
    const { runSandbox } = require('./migration-sandbox');
    result = runSandbox();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return result;
}

// ─── 4. SEMVER RECOMMENDATION ─────────────────────────────────────────────────
function recommendSemver(findings, gitCtx, sandboxResult) {
  const reasons = [];

  // MAJOR triggers
  const destructiveDb = findings.filter(f =>
    f.id === 'DB-DESTRUCTIVE' || f.id === 'DB-ROLLBACK-BROKEN');
  const breakingApi   = findings.filter(f =>
    f.id === 'API-SCHEMA-DRIFT' || f.id === 'API-SCHEMA-PRICE' || f.id === 'API-METHOD-MISMATCH');
  const brokenSandbox = [...sandboxResult.broken, ...sandboxResult.missingDown];
  const breakingCommits = gitCtx.commits.filter(c =>
    c.type === 'breaking' || /BREAKING/.test(c.msg));

  if (destructiveDb.length > 0) {
    reasons.push(`${destructiveDb.length} destructive DB operation(s) (DROP/RENAME column)`);
  }
  if (breakingApi.length > 0) {
    reasons.push(`${breakingApi.length} breaking API contract change(s)`);
  }
  if (breakingCommits.length > 0) {
    reasons.push(`${breakingCommits.length} commit(s) flagged BREAKING CHANGE`);
  }
  if (reasons.length > 0) return { level: 'MAJOR', reasons };

  // MINOR triggers
  const newEndpoints = findings.filter(f => f.id === 'API-UNDOCUMENTED');
  const additiveMigs = findings.filter(f =>
    f.id === 'DB-ROLLBACK' || (f.id === 'DB-DESTRUCTIVE' && /ADD\s+COLUMN/i.test(f.detail || '')));
  const featCommits  = gitCtx.commits.filter(c => c.type === 'feat');

  if (newEndpoints.length > 0) {
    reasons.push(`${newEndpoints.length} undocumented new endpoint(s) detected`);
  }
  if (additiveMigs.length > 0) {
    reasons.push(`${additiveMigs.length} additive migration(s) detected`);
  }
  if (featCommits.length > 0) {
    reasons.push(`${featCommits.length} feature commit(s) in range`);
  }
  if (reasons.length > 0) return { level: 'MINOR', reasons };

  // PATCH — everything else
  const patchTypes = ['fix', 'docs', 'test', 'chore', 'refactor'];
  const patchCommits = gitCtx.commits.filter(c => patchTypes.includes(c.type));
  if (patchCommits.length > 0) {
    reasons.push(`${patchCommits.length} patch/fix/chore commit(s) in range`);
  } else {
    reasons.push('No feature or breaking changes detected');
  }
  return { level: 'PATCH', reasons };
}

// ─── 5. READINESS SCORE (0–100) ───────────────────────────────────────────────
function computeReadinessScore(findings, sandboxResult, gitCtx) {
  let score = 100;
  const deductions = [];

  // Coverage check — look for test files
  const routeDir = path.join(ROOT, 'src', 'routes');
  let routeCount = 0, testedCount = 0;
  if (fs.existsSync(routeDir)) {
    const routes = fs.readdirSync(routeDir).filter(f => f.endsWith('.js'));
    routeCount = routes.length;
    testedCount = routes.filter(r =>
      fs.existsSync(path.join(ROOT, 'tests', 'routes', r.replace('.js', '.test.js')))).length;
  }
  const coveragePct = routeCount > 0 ? Math.round((testedCount / routeCount) * 100) : 100;
  if (coveragePct < 100) {
    const ded = Math.round((1 - testedCount / routeCount) * 20);
    score -= ded;
    deductions.push(`-${ded} (test coverage ${coveragePct}% — ${routeCount - testedCount} route(s) untested)`);
  }

  // Findings deductions
  const criticals = findings.filter(f => f.severity === 'CRITICAL');
  const highs     = findings.filter(f => f.severity === 'HIGH');
  const mediums   = findings.filter(f => f.severity === 'MEDIUM');
  if (criticals.length > 0) {
    const ded = criticals.length * 20;
    score -= ded;
    deductions.push(`-${ded} (${criticals.length} CRITICAL finding(s))`);
  }
  if (highs.length > 0) {
    const ded = highs.length * 10;
    score -= ded;
    deductions.push(`-${ded} (${highs.length} HIGH finding(s))`);
  }
  if (mediums.length > 0) {
    const ded = mediums.length * 3;
    score -= ded;
    deductions.push(`-${ded} (${mediums.length} MEDIUM finding(s))`);
  }

  // Sandbox failures
  const brokenCount = sandboxResult.broken.length + sandboxResult.missingDown.length;
  if (brokenCount > 0) {
    const ded = brokenCount * 15;
    score -= ded;
    deductions.push(`-${ded} (${brokenCount} DB-ROLLBACK-BROKEN migration(s))`);
  }

  return { score: Math.max(0, score), coveragePct, deductions };
}

// ─── 6. MARKDOWN GENERATION ───────────────────────────────────────────────────
function buildMarkdown(meta) {
  const {
    git: gitCtx, findings, sandboxResult, semver,
    readiness, pkg, timestamp, migrationRows,
  } = meta;

  const blocked  = findings.filter(f =>
    f.severity === 'CRITICAL' || f.severity === 'HIGH').length > 0;
  const statusBanner = blocked
    ? '## 🔴 RELEASE BLOCKED'
    : `## ✅ RELEASE APPROVED`;
  const statusLine = blocked
    ? `> **Release is blocked.** Resolve all CRITICAL and HIGH findings before deploying \`v${pkg.version}\`.`
    : `> **Release may proceed.** No critical or high-severity findings detected for \`v${pkg.version}\`.`;

  const scoreEmoji = readiness.score >= 80 ? '🟢' : readiness.score >= 50 ? '🟡' : '🔴';
  const semverColor = semver.level === 'MAJOR' ? '🔴' : semver.level === 'MINOR' ? '🟡' : '🟢';

  // ── Section helpers ──
  const h2 = (t) => `\n## ${t}\n`;
  const h3 = (t) => `\n### ${t}\n`;
  const row = (...cols) => `| ${cols.join(' | ')} |`;
  const thr = (...cols) => row(...cols) + '\n' + row(...cols.map(() => '---'));

  // ── Git commits table ──
  const commitTypeIcon = { feat:'✨', fix:'🐛', docs:'📝', test:'🧪', chore:'🔧', refactor:'♻️', breaking:'💥', other:'◦' };
  const commitRows = gitCtx.commits.map(c =>
    row(`\`${c.sha}\``, commitTypeIcon[c.type] || '◦', c.msg.replace(/\|/g, '\\|'))
  ).join('\n');

  // ── Findings summary ──
  const critical = findings.filter(f => f.severity === 'CRITICAL');
  const high     = findings.filter(f => f.severity === 'HIGH');
  const medium   = findings.filter(f => f.severity === 'MEDIUM');
  const acked    = findings.filter(f => f.severity === 'ACKNOWLEDGED');

  const findingsSummary = `
| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | ${critical.length} |
| 🟠 HIGH | ${high.length} |
| 🟡 MEDIUM | ${medium.length} |
| ✅ ACKNOWLEDGED | ${acked.length} |
| **Total** | **${findings.length}** |
`.trim();

  // ── Breaking changes section ──
  const breakingFindings = findings.filter(f =>
    ['DB-DESTRUCTIVE', 'API-SCHEMA-DRIFT', 'API-SCHEMA-PRICE', 'API-METHOD-MISMATCH'].includes(f.id));

  const breakingRows = breakingFindings.length > 0
    ? breakingFindings.map(f =>
        row(`\`${f.id}\``, f.title.replace(/\|/g, '\\|'), f.file ? `\`${f.file}\`` : '—')
      ).join('\n')
    : row('—', '_No breaking changes detected_', '—');

  // ── Migration sandbox table ──
  const allMigs = fs.existsSync(path.join(ROOT, 'migrations'))
    ? fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.up.sql')).sort()
    : [];

  const sandboxRows = allMigs.map(up => {
    const name     = up.replace('.up.sql', '');
    const upSql    = read(`migrations/${up}`) || '';
    const hasDown  = fs.existsSync(path.join(ROOT, 'migrations', up.replace('.up.sql', '.down.sql')));
    const opType   = /DROP\s+TABLE/i.test(upSql)    ? '`DROP TABLE`'
                   : /DROP\s+COLUMN/i.test(upSql)   ? '`DROP COLUMN`'
                   : /RENAME\s+COLUMN/i.test(upSql) ? '`RENAME COLUMN`'
                   : /ADD\s+COLUMN/i.test(upSql)    ? '`ADD COLUMN`'
                   : /CREATE\s+TABLE/i.test(upSql)  ? '`CREATE TABLE`'
                   : '`ALTER`';
    const isBroken = sandboxResult.broken.some(b => b.migration === name)
                  || sandboxResult.missingDown.some(b => b.migration === name);
    const passedSandbox = sandboxResult.passed.some(b => b.migration === name);
    const dialectNote = opType.includes('RENAME') || opType.includes('DROP COLUMN')
      ? '⚠️ PG-specific'
      : '✅ Compatible';
    const sandboxStatus = isBroken    ? '❌ `DB-ROLLBACK-BROKEN`'
                        : passedSandbox ? '✅ `VERIFIED PASS`'
                        : '⚠️ Not tested';
    return row(`\`${name}\``, opType, dialectNote, hasDown ? '✅ Present' : '❌ Missing', sandboxStatus);
  }).join('\n');

  // ── Security findings ──
  const secFindings = findings.filter(f =>
    f.id.startsWith('SEC-') || f.id.startsWith('API-'));
  const secRows = secFindings.length > 0
    ? secFindings.map(f =>
        row(
          f.severity === 'CRITICAL' ? '🔴 CRITICAL' : f.severity === 'HIGH' ? '🟠 HIGH' : '🟡 MEDIUM',
          `\`${f.id}\``,
          f.title.replace(/\|/g, '\\|'),
          f.file ? `\`${f.file}\`` : '—'
        )
      ).join('\n')
    : row('✅', '—', '_No security issues found_', '—');

  // ── Action items ──
  const actions = [];
  if (high.length > 0 || critical.length > 0) {
    actions.push(row('🔴 Blocking', 'Resolve all CRITICAL/HIGH findings', '`node scripts/pre-flight-check.js`'));
  }
  const dbDestructive = findings.filter(f => f.id === 'DB-DESTRUCTIVE');
  if (dbDestructive.length > 0) {
    actions.push(row('🟠 DB Risk', 'DBA review + sign-off required for destructive migrations', '`node scripts/pre-flight-check.js --approve-db-risks`'));
  }
  const autoFixable = findings.filter(f =>
    ['SEC-ADMIN-AUTH', 'API-METHOD-MISMATCH', 'API-SPEC-VERSION', 'TST-MISSING'].includes(f.id));
  if (autoFixable.length > 0) {
    actions.push(row('🟡 Auto-Fix', `${autoFixable.length} finding(s) can be auto-remediated`, '`node scripts/pre-flight-check.js --fix`'));
  }
  actions.push(row('📋 Notes', 'Regenerate this document after changes', '`node scripts/generate-release-notes.js`'));
  actions.push(row('🗄️ Sandbox', 'Re-verify all migration roundtrips', '`node scripts/migration-sandbox.js`'));
  actions.push(row('🚀 Dashboard', 'Open live risk dashboard', '`node bin/releaseguard.js ui`'));

  const actionRows = actions.join('\n');

  // ── Modified files (git diff) ──
  const modifiedSection = gitCtx.modifiedFiles.length > 0
    ? gitCtx.modifiedFiles.map(f => `- \`${f}\``).join('\n')
    : '_No file changes detected in HEAD~1 diff._';

  // ── Assemble full document ──
  return `${statusBanner}

${statusLine}

${h2('🛡️ Executive Release Summary')}

| Field | Value |
|-------|-------|
| **Project** | \`${pkg.name}\` |
| **Current version** | \`v${pkg.version}\` |
| **Branch** | \`${gitCtx.branch}\` |
| **HEAD commit** | \`${gitCtx.headSha}\` |
| **Last tag/baseline** | \`${gitCtx.lastTag || 'none'}\` |
| **Semver recommendation** | ${semverColor} **${semver.level}** bump |
| **Release confidence score** | ${scoreEmoji} **${readiness.score} / 100** |
| **Test coverage (routes)** | ${readiness.coveragePct}% |
| **Generated** | ${timestamp} |

${h3('Score Deductions')}
${readiness.deductions.length > 0
  ? readiness.deductions.map(d => `- ${d}`).join('\n')
  : '- None — full score maintained'}

${h3('Semver Rationale')}
${semver.reasons.map(r => `- ${r}`).join('\n')}

${h2('⚠️ Breaking Changes & Deprecations')}

${thr('Finding ID', 'Description', 'File')}
${breakingRows}

${h2('🗄️ Database & Rollback Verification')}

${thr('Migration', 'Operation', 'Dialect', 'Rollback Script', 'Sandbox Result')}
${sandboxRows}

${h2('🔍 Full Findings Summary')}

${findingsSummary}

${h2('🔒 Security & Middleware Audit')}

${thr('Severity', 'Finding ID', 'Description', 'File')}
${secRows}

${h2('📦 Recent Commits (last 10)')}

${thr('SHA', 'Type', 'Message')}
${commitRows}

${h2('📁 Files Modified Since HEAD~1')}

${modifiedSection}

${h2('🚀 Developer Action Items')}

${thr('Priority', 'Action', 'Command')}
${actionRows}

---
<sub>Generated by **ReleaseGuard AI** · \`v${pkg.version}\` · ${timestamp}</sub>
`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function main() {
  console.log(BOLD('\n🛡️  ReleaseGuard AI — Release Notes Synthesizer\n'));
  console.log(DIM('  Collecting git context…'));

  const pkg = (() => {
    try { return JSON.parse(read('package.json') || '{}'); } catch (_) { return {}; }
  })();

  const gitCtx      = collectGitContext();
  console.log(DIM(`  Branch: ${gitCtx.branch}  HEAD: ${gitCtx.headSha}  Last tag: ${gitCtx.lastTag || 'none'}`));

  console.log(DIM('  Running pre-flight checks…'));
  const findings    = collectFindings();
  console.log(DIM(`  ${findings.length} finding(s) collected.`));

  console.log(DIM('  Running migration sandbox…'));
  const sandboxResult = collectSandboxResults();
  const totalSandbox  = sandboxResult.passed.length + sandboxResult.broken.length + sandboxResult.missingDown.length;
  console.log(DIM(`  ${sandboxResult.passed.length}/${totalSandbox} migration(s) verified.`));

  const semver    = recommendSemver(findings, gitCtx, sandboxResult);
  const readiness = computeReadinessScore(findings, sandboxResult, gitCtx);
  const timestamp = new Date().toUTCString();

  const meta = { git: gitCtx, findings, sandboxResult, semver, readiness, pkg, timestamp };

  const markdown = buildMarkdown(meta);

  if (!DRY_RUN) {
    fs.writeFileSync(OUT_FILE, markdown, 'utf8');
    console.log(GREEN(BOLD(`\n  ✔  RELEASE_NOTES.md written → ${OUT_FILE}`)));
  } else {
    console.log(DIM('\n  [dry-run] Skipping file write.\n'));
    console.log(markdown);
  }

  if (JSON_MODE) {
    const jsonMeta = {
      version:    pkg.version,
      branch:     gitCtx.branch,
      headSha:    gitCtx.headSha,
      lastTag:    gitCtx.lastTag,
      semver:     semver.level,
      semverReasons: semver.reasons,
      readinessScore: readiness.score,
      coveragePct: readiness.coveragePct,
      scoreDeductions: readiness.deductions,
      findings: findings.map(f => ({ severity: f.severity, id: f.id, title: f.title, file: f.file })),
      sandbox: {
        passed:     sandboxResult.passed.map(p => p.migration),
        broken:     sandboxResult.broken.map(b => b.migration),
        missingDown: sandboxResult.missingDown.map(m => m.migration),
      },
      blocked: findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH'),
      timestamp,
    };
    process.stdout.write('\n' + JSON.stringify(jsonMeta, null, 2) + '\n');
  }

  // Print summary
  const blocked      = findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').length > 0;
  const semverColorFn = semver.level === 'MAJOR' ? RED : semver.level === 'MINOR' ? YELLOW : GREEN;
  const scoreColorFn  = readiness.score >= 80 ? GREEN : readiness.score >= 50 ? YELLOW : RED;
  console.log();
  console.log(`  ${DIM('Semver recommendation:')}  ${semverColorFn(BOLD(semver.level))}`);
  console.log(`  ${DIM('Readiness score:     ')}  ${scoreColorFn(BOLD(`${readiness.score}/100`))}`);
  console.log(`  ${DIM('Release status:      ')}  ${blocked ? RED(BOLD('BLOCKED')) : GREEN(BOLD('APPROVED'))}`);
  console.log();
}

main();
