#!/usr/bin/env node
'use strict';
/**
 * ReleaseGuard AI — Interactive Developer CLI
 *
 * Commands:
 *   releaseguard check        Alias for 'audit' — runs pre-flight checks
 *   releaseguard audit        Run pre-flight checks, print formatted table
 *   releaseguard fix          Trigger auto-remediation engine
 *   releaseguard verify-db    Run migration dry-run sandbox
 *   releaseguard ui           Launch the dashboard server on port 3000
 *   releaseguard dba-signoff  Run verification with --approve-db-risks
 *   releaseguard comment      Output GitHub PR markdown comment
 *
 * Flags:
 *   --help / -h   Show help
 *   -v            Print version and exit
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const R  = (s) => `\x1b[31m${s}\x1b[0m`;
const Y  = (s) => `\x1b[33m${s}\x1b[0m`;
const G  = (s) => `\x1b[32m${s}\x1b[0m`;
const B  = (s) => `\x1b[34m${s}\x1b[0m`;
const C  = (s) => `\x1b[36m${s}\x1b[0m`;
const M  = (s) => `\x1b[35m${s}\x1b[0m`;
const WB = (s) => `\x1b[1;37m${s}\x1b[0m`;
const BO = (s) => `\x1b[1m${s}\x1b[0m`;
const DI = (s) => `\x1b[2m${s}\x1b[0m`;
const UL = (s) => `\x1b[4m${s}\x1b[0m`;

const ROOT          = path.resolve(__dirname, '..');
const SCRIPTS       = path.join(ROOT, 'scripts');
const CHECK_SCRIPT  = path.join(SCRIPTS, 'pre-flight-check.js');
const FIX_SCRIPT    = path.join(SCRIPTS, 'auto-fix.js');
const PR_SCRIPT     = path.join(SCRIPTS, 'pr-commenter.js');
const SANDBOX_SCRIPT = path.join(SCRIPTS, 'migration-sandbox.js');
const DASHBOARD_SERVER = path.join(ROOT, 'dashboard', 'server.js');

// ─── Box drawing ──────────────────────────────────────────────────────────────
function box(lines, color = WB) {
  const width = Math.max(...lines.map(l => stripAnsi(l).length)) + 4;
  const top    = color('╔' + '═'.repeat(width - 2) + '╗');
  const bottom = color('╚' + '═'.repeat(width - 2) + '╝');
  const mid    = lines.map(l => {
    const pad = width - 2 - stripAnsi(l).length - 2;
    return color('║') + '  ' + l + ' '.repeat(pad) + color('║');
  });
  return [top, ...mid, bottom].join('\n');
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function hr(char = '─', width = 70, colorFn = DI) {
  return colorFn(char.repeat(width));
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(subtitle) {
  console.log();
  console.log(box([
    BO('🛡️  ReleaseGuard AI'),
    DI('Enterprise Pre-Flight Gate'),
    '',
    C(subtitle),
  ]));
  console.log();
}

// ─── Severity badge ───────────────────────────────────────────────────────────
function badge(severity) {
  const badges = {
    CRITICAL:     R(' CRITICAL '),
    HIGH:         Y('  HIGH    '),
    MEDIUM:       Y('  MEDIUM  '),
    INFO:         B('   INFO   '),
    ACKNOWLEDGED: G('  ACK\'D   '),
  };
  return `\x1b[1m${badges[severity] || DI(severity.padEnd(10))}\x1b[0m`;
}

// ─── Formatted findings table ─────────────────────────────────────────────────
function printFindingsTable(findings) {
  if (findings.length === 0) {
    console.log(G(BO('  ✔  No findings — clean bill of health.\n')));
    return;
  }

  const cols = { sev: 12, id: 24, title: 46, file: 34 };
  const headerSev   = BO(UL('SEVERITY'.padEnd(cols.sev)));
  const headerID    = BO(UL('ID'.padEnd(cols.id)));
  const headerTitle = BO(UL('FINDING'.padEnd(cols.title)));
  const headerFile  = BO(UL('FILE'.padEnd(cols.file)));

  console.log(`  ${headerSev}  ${headerID}  ${headerTitle}  ${headerFile}`);
  console.log(hr('─', 122));

  for (const f of findings) {
    const sev   = badge(f.severity).padEnd(cols.sev + 20); // +20 for ANSI codes
    const id    = C(f.id.padEnd(cols.id));
    const title = (f.title.length > cols.title - 1
      ? f.title.slice(0, cols.title - 2) + '…'
      : f.title).padEnd(cols.title);
    const file  = f.file ? DI(f.file.length > cols.file - 1
      ? '…' + f.file.slice(-(cols.file - 2))
      : f.file) : DI('—');

    console.log(`  ${sev}  ${id}  ${title}  ${file}`);
    console.log(`  ${' '.repeat(cols.sev + 2)}  ${' '.repeat(cols.id + 2)}  ${DI(
      f.detail.length > 90 ? f.detail.slice(0, 89) + '…' : f.detail
    )}`);
    console.log();
  }

  console.log(hr('─', 122));
  const critical = findings.filter(f => f.severity === 'CRITICAL').length;
  const high     = findings.filter(f => f.severity === 'HIGH').length;
  const medium   = findings.filter(f => f.severity === 'MEDIUM').length;
  const acked    = findings.filter(f => f.severity === 'ACKNOWLEDGED').length;

  console.log(
    `  ${R(BO(`${critical} critical`))}  ` +
    `${Y(BO(`${high} high`))}  ` +
    `${Y(`${medium} medium`)}` +
    (acked ? `  ${G(`${acked} acknowledged`)}` : '')
  );
  console.log(hr('─', 122));
  console.log();
}

// ─── Run a child script and stream output ────────────────────────────────────
function runScript(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  return result.status || 0;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function cmdAudit() {
  printBanner('audit — pre-flight check');
  const { runChecks } = require(path.join(SCRIPTS, 'pre-flight-check'));
  const findings = runChecks();
  printFindingsTable(findings);

  const blocked = findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  if (blocked.length > 0) {
    console.log(R(BO('  ✖  RELEASE BLOCKED — resolve critical/high findings before deploying.\n')));
    process.exit(1);
  } else {
    console.log(G(BO('  ✔  Release may proceed.\n')));
    process.exit(0);
  }
}

function cmdFix() {
  printBanner('fix — autonomous remediation');
  const code = runScript(CHECK_SCRIPT, ['--fix']);
  process.exit(code);
}

function cmdDbaSignoff() {
  printBanner('dba-signoff — DBA risk acknowledgement');
  const code = runScript(CHECK_SCRIPT, ['--approve-db-risks']);
  process.exit(code);
}

function cmdComment() {
  printBanner('comment — GitHub PR markdown');
  const code = runScript(PR_SCRIPT);
  process.exit(code);
}

function cmdVerifyDb() {
  printBanner('verify-db — migration dry-run sandbox');
  const code = runScript(SANDBOX_SCRIPT);
  process.exit(code);
}

function cmdUi() {
  printBanner('ui — dashboard server');
  console.log(C(`  Launching ReleaseGuard AI Dashboard → http://localhost:3000\n`));
  console.log(DI('  Press Ctrl+C to stop.\n'));
  // Spawn the dashboard server in the foreground (inherits stdio so logs stream to terminal)
  const result = spawnSync(process.execPath, [DASHBOARD_SERVER], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  process.exit(result.status || 0);
}

function cmdVersion() {
  const pkg = (() => {
    try { return JSON.parse(require('fs').readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
    catch (_) { return {}; }
  })();
  console.log(`releaseguard v${pkg.version || '0.0.0'}`);
  process.exit(0);
}

function cmdHelp() {
  printBanner('help');
  console.log([
    `  ${BO('Usage:')}  ${C('releaseguard')} ${Y('<command>')} ${DI('[flags]')}`,
    '',
    `  ${BO('Commands:')}`,
    `    ${G('check')}         Alias for audit — run pre-flight checks`,
    `    ${G('audit')}         Run pre-flight checks and print a formatted findings table`,
    `    ${G('fix')}           Trigger autonomous remediation engine`,
    `    ${G('verify-db')}     Run migration dry-run sandbox (up+down roundtrip in SQLite)`,
    `    ${G('ui')}            Launch the interactive dashboard on http://localhost:3000`,
    `    ${G('dba-signoff')}   Run verification with DBA risk acknowledgement`,
    `    ${G('comment')}       Generate and output GitHub PR markdown comment`,
    `    ${G('help')}          Show this help message`,
    '',
    `  ${BO('Flags:')}`,
    `    ${Y('--help')} / ${Y('-h')}   Show this help message`,
    `    ${Y('-v')}             Print version and exit`,
    '',
    `  ${BO('Examples:')}`,
    `    ${DI('$ releaseguard check')}`,
    `    ${DI('$ releaseguard audit')}`,
    `    ${DI('$ releaseguard fix')}`,
    `    ${DI('$ releaseguard verify-db')}`,
    `    ${DI('$ releaseguard ui')}`,
    `    ${DI('$ releaseguard dba-signoff')}`,
    `    ${DI('$ releaseguard comment')}`,
    '',
  ].join('\n'));
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case 'check':
  case 'audit':       cmdAudit();       break;
  case 'fix':         cmdFix();         break;
  case 'verify-db':   cmdVerifyDb();    break;
  case 'ui':          cmdUi();          break;
  case 'dba-signoff': cmdDbaSignoff();  break;
  case 'comment':     cmdComment();     break;
  case 'help':
  case '--help':
  case '-h':          cmdHelp();        break;
  case '-v':          cmdVersion();     break;
  default:
    if (cmd) {
      console.error(R(`\n  Unknown command: ${BO(cmd)}\n`));
    }
    cmdHelp();
    process.exit(cmd ? 1 : 0);
}
