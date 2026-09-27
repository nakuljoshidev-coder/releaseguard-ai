'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { execFile, spawn } = require('child_process');

const app  = express();
const ROOT = path.resolve(__dirname, '..');
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── helpers ──────────────────────────────────────────────────────────────────

function readFile(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function listMigrations() {
  const dir = path.join(ROOT, 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

// ─── Static audit data (parsed from the repo, same logic as pre-flight) ───────

function buildAuditData() {
  const migrations = listMigrations();
  const upFiles    = migrations.filter(f => f.endsWith('.up.sql'));
  const downFiles  = new Set(migrations.filter(f => f.endsWith('.down.sql')));

  const migrationRows = upFiles.map(up => {
    const down      = up.replace('.up.sql', '.down.sql');
    const sql       = readFile(`migrations/${up}`) || '';
    const hasRollback = downFiles.has(down);
    const isDestructive = /DROP\s+COLUMN|RENAME\s+COLUMN|DROP\s+TABLE/i.test(sql);
    const noDefault = /ADD\s+COLUMN\s+\w+[^;]*NOT\s+NULL/i.test(sql) && !/DEFAULT\s+/i.test(sql);
    let risk = 'LOW';
    if (isDestructive && !hasRollback) risk = 'CRITICAL';
    else if (isDestructive) risk = 'HIGH';
    else if (noDefault) risk = 'CRITICAL';
    return { name: up, hasRollback, isDestructive, noDefault, risk };
  });

  // Rollback scripts content
  const rollbacks = [];
  for (const down of ['003_add_username_role_to_users.down.sql', '004_drop_price_from_orders.down.sql']) {
    const content = readFile(`migrations/${down}`);
    if (content) rollbacks.push({ name: down, content });
  }

  // Security check — admin routes auth
  const adminSrc = readFile('src/routes/admin.js') || '';
  const adminHasAuth = /requireAuth|authenticate|verifyToken/i.test(adminSrc);
  const adminRouteCount = (adminSrc.match(/router\.(get|post|put|patch|delete)\s*\(/g) || []).length;

  // Bulk validation
  const ordersSrc = readFile('src/routes/orders.js') || '';
  const bulkLine  = ordersSrc.split('\n').find(l => /\/bulk/.test(l) && /router\.post/.test(l));
  const bulkHasValidation = bulkLine ? /validate(Order|BulkOrders)/.test(bulkLine) : true;

  // Spec version
  const spec      = readFile('openapi.yaml') || '';
  const pkg       = JSON.parse(readFile('package.json') || '{}');
  const specVerM  = spec.match(/^\s*version:\s*["']?(\d+\.\d+\.\d+)/m);
  const specVer   = specVerM ? specVerM[1] : '?';
  const codeVer   = pkg.version || '?';
  const specInSync = specVer === codeVer;

  // UserInput schema
  const userInputBlock = spec.match(/UserInput:[\s\S]*?(?=\n    \w|\ncomponents|\z)/);
  let userSchemaOk = true;
  if (userInputBlock) {
    const reqM = userInputBlock[0].match(/required:([\s\S]*?)properties:/);
    if (reqM && /^\s+-\s+name\s*$/m.test(reqM[1])) userSchemaOk = false;
  }

  // OrderInput price
  const orderInputBlock = spec.match(/OrderInput:[\s\S]*?(?=\n    \w|\ncomponents|\z)/);
  let orderSchemaOk = true;
  if (orderInputBlock) {
    const reqM = orderInputBlock[0].match(/required:([\s\S]*?)properties:/);
    if (reqM && /^\s+-\s+price\s*$/m.test(reqM[1])) orderSchemaOk = false;
  }

  // Compute domain scores
  const securityIssues = [
    !adminHasAuth && `${adminRouteCount} admin route(s) have no auth middleware`,
    !bulkHasValidation && 'POST /orders/bulk missing validation',
  ].filter(Boolean);

  const migrationIssues = migrationRows
    .filter(m => m.risk === 'CRITICAL' || m.risk === 'HIGH')
    .map(m => `${m.name}: ${m.risk}${!m.hasRollback ? ' (no rollback)' : ''}`);

  const apiIssues = [
    !specInSync && `Spec version ${specVer} ≠ code version ${codeVer}`,
    !userSchemaOk && "UserInput still documents 'name' (should be 'username')",
    !orderSchemaOk && "OrderInput still requires 'price' (column dropped)",
  ].filter(Boolean);

  const totalIssues = securityIssues.length + migrationIssues.length + apiIssues.length;
  const riskScore   = Math.min(10, 3 + totalIssues * 1.2 | 0);

  const auditReport = readFile('RELEASE_AUDIT.md') || '_RELEASE_AUDIT.md not found._';

  return {
    version: codeVer,
    specVersion: specVer,
    riskScore,
    timestamp: new Date().toISOString(),
    domains: {
      security: {
        label: 'Security & Middleware',
        status: securityIssues.length === 0 ? 'PASS' : 'FAIL',
        issues: securityIssues,
        detail: adminHasAuth
          ? `All ${adminRouteCount} admin routes are protected by requireAuth + requireRole.`
          : `${adminRouteCount} admin routes are exposed without authentication.`,
      },
      migrations: {
        label: 'Database Migration Safety',
        status: migrationIssues.length === 0 ? 'PASS' : 'WARN',
        issues: migrationIssues,
        rows: migrationRows,
      },
      api: {
        label: 'API Contract Drift',
        status: apiIssues.length === 0 ? 'PASS' : 'FAIL',
        issues: apiIssues,
        detail: specInSync
          ? `Spec v${specVer} matches code v${codeVer}.`
          : `Spec v${specVer} is stale vs code v${codeVer}.`,
      },
    },
    rollbacks,
    auditReport,
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────

// GET /api/audit — static analysis of current repo state
app.get('/api/audit', (_req, res) => {
  res.json(buildAuditData());
});

// POST /api/run-audit — execute pre-flight-check.js and return live output + parsed data
app.post('/api/run-audit', (req, res) => {
  const script = path.join(ROOT, 'scripts', 'pre-flight-check.js');
  execFile(process.execPath, [script], { cwd: ROOT, timeout: 30_000 }, (err, stdout, stderr) => {
    // Strip ANSI escape codes for clean JSON output
    const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const output = clean(stdout + stderr);

    // Re-run static analysis so the UI cards refresh
    const audit = buildAuditData();

    // Extract finding counts from script output
    const countMatch = output.match(/(\d+)\s+critical.*?(\d+)\s+high.*?(\d+)\s+medium/);
    res.json({
      exitCode: err ? err.code || 1 : 0,
      output,
      critical: countMatch ? Number(countMatch[1]) : 0,
      high:     countMatch ? Number(countMatch[2]) : 0,
      medium:   countMatch ? Number(countMatch[3]) : 0,
      blocked:  !!(err),
      audit,
    });
  });
});

// ─── SSE: /api/stream-audit ───────────────────────────────────────────────────
// Streams pre-flight-check.js stdout/stderr line-by-line as Server-Sent Events.
// Each event: { type: 'line'|'done'|'error', data: string, exitCode?: number }
app.get('/api/stream-audit', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering if present
  res.flushHeaders();

  const script = path.join(ROOT, 'scripts', 'pre-flight-check.js');
  const args   = [];
  if (req.query.fix    === '1') args.push('--fix');
  if (req.query.dba    === '1') args.push('--approve-db-risks');
  if (req.query.sandbox=== '1') {
    // Stream the sandbox script instead
    const sandboxScript = path.join(ROOT, 'scripts', 'migration-sandbox.js');
    streamScript(sandboxScript, [], res);
    return;
  }

  streamScript(script, args, res);
});

function streamScript(script, args, res) {
  // Strip ANSI colour codes for clean terminal rendering in browser
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  function send(type, data, extra = {}) {
    const payload = JSON.stringify({ type, data: stripAnsi(data), ...extra });
    res.write(`data: ${payload}\n\n`);
  }

  send('start', `$ node ${path.basename(script)} ${args.join(' ')}`.trim());

  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';

  function flushBuffer(chunk) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();  // keep incomplete last line
    for (const line of lines) {
      send('line', line);
    }
  }

  child.stdout.on('data', (chunk) => flushBuffer(chunk.toString()));
  child.stderr.on('data', (chunk) => flushBuffer(chunk.toString()));

  child.on('close', (code) => {
    if (buffer.trim()) send('line', buffer);  // flush any remaining
    send('done', code === 0 ? '✔  Completed successfully.' : `✖  Exited with code ${code}.`, { exitCode: code });
    res.end();
  });

  child.on('error', (err) => {
    send('error', `Failed to start script: ${err.message}`);
    res.end();
  });

  // Client disconnect → kill child
  res.on('close', () => { try { child.kill(); } catch (_) {} });
}

// Catch-all → index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🛡️  ReleaseGuard AI Dashboard running → http://localhost:${PORT}\n`);
});
