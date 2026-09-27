'use strict';
/**
 * ReleaseGuard AI — Auto-Remediation Engine
 *
 * Invoked by pre-flight-check.js when --fix is passed.
 * Applies targeted patches to resolve known finding IDs and returns
 * a summary of every change made.
 *
 * Exported API:
 *   applyFixes(findings) → { applied: [{id, description, file}], skipped: [{id, reason}] }
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── ANSI helpers (re-declared so this module is self-contained) ──────────────
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;

function abs(rel) { return path.join(ROOT, rel); }
function read(rel) {
  const p = abs(rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function write(rel, content) {
  const p = abs(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

// ─── Applied / skipped accumulators ──────────────────────────────────────────
const applied = [];
const skipped = [];

function didFix(id, description, file) {
  applied.push({ id, description, file });
  console.log(`  ${GREEN('✔')}  ${BOLD('Fixed:')} ${CYAN(id)} — ${description}`);
  if (file) console.log(`       ${DIM('→ ' + file)}`);
}

function didSkip(id, reason) {
  skipped.push({ id, reason });
  console.log(`  ${YELLOW('○')}  ${BOLD('Skipped:')} ${CYAN(id)} — ${reason}`);
}

// =============================================================================
// FIX 1 — SEC-ADMIN-AUTH
// Inject requireAuth + requireRole('admin') into src/routes/admin.js
// if the file has route registrations but no auth middleware.
// =============================================================================
function fixAdminAuth(findings) {
  const hasIt = findings.some((f) => f.id === 'SEC-ADMIN-AUTH');
  if (!hasIt) return;

  const rel = 'src/routes/admin.js';
  const src = read(rel);
  if (!src) { didSkip('SEC-ADMIN-AUTH', `${rel} not found`); return; }

  // Already has auth — nothing to do (shouldn't happen if finding fired, but be safe)
  if (/requireAuth|authenticate|verifyToken/i.test(src)) {
    didSkip('SEC-ADMIN-AUTH', 'auth middleware already present');
    return;
  }

  // Ensure the middleware import exists
  const hasImport = /require\(['"]\.\.\/middleware\/validate['"]\)/.test(src);

  let patched = src;

  if (!hasImport) {
    // Insert import after the last existing require line
    patched = patched.replace(
      /((?:const\s+\w+\s*=\s*require\([^)]+\);?\n)+)/,
      (match) => match + `const { requireAuth, requireRole } = require('../middleware/validate');\n`
    );
  }

  // Insert router.use() calls before the first route registration
  patched = patched.replace(
    /(router\.(get|post|put|patch|delete)\s*\()/,
    `// All admin routes require authentication and the 'admin' role.\nrouter.use(requireAuth);\nrouter.use(requireRole('admin'));\n\n$1`
  );

  write(rel, patched);
  didFix('SEC-ADMIN-AUTH', "injected requireAuth + requireRole('admin') middleware", rel);
}

// =============================================================================
// FIX 2 — API-METHOD-MISMATCH
// Update openapi.yaml: replace `patch:` with `put:` under /api/v1/orders/{id}
// when the route file uses router.put() instead of router.patch().
// =============================================================================
function fixMethodMismatch(findings) {
  const hasIt = findings.some((f) => f.id === 'API-METHOD-MISMATCH');
  if (!hasIt) return;

  const rel = 'openapi.yaml';
  const spec = read(rel);
  if (!spec) { didSkip('API-METHOD-MISMATCH', `${rel} not found`); return; }

  // Find the /api/v1/orders/{id} block and swap patch: → put: within it only.
  // We isolate the block by matching from the path key to the next top-level path key.
  const patched = spec.replace(
    /(\/api\/v1\/orders\/\{id\}:[\s\S]*?)(?=\n  \/|\ncomponents:|$)/,
    (block) => {
      if (/^\s+put:/m.test(block)) {
        // put: already exists — skip
        return block;
      }
      return block.replace(/^(\s+)patch:/m, '$1put:');
    }
  );

  if (patched === spec) {
    didSkip('API-METHOD-MISMATCH', 'could not locate patch: entry in /api/v1/orders/{id} block');
    return;
  }

  write(rel, patched);
  didFix('API-METHOD-MISMATCH', 'replaced patch: with put: under /api/v1/orders/{id} in openapi.yaml', rel);
}

// =============================================================================
// FIX 3 — API-SPEC-VERSION
// Sync openapi.yaml info.version to match package.json version.
// =============================================================================
function fixSpecVersion(findings) {
  const hasIt = findings.some((f) => f.id === 'API-SPEC-VERSION');
  if (!hasIt) return;

  const pkgRaw = read('package.json');
  if (!pkgRaw) { didSkip('API-SPEC-VERSION', 'package.json not found'); return; }

  let pkgVer;
  try { pkgVer = JSON.parse(pkgRaw).version; } catch (_) {
    didSkip('API-SPEC-VERSION', 'could not parse package.json'); return;
  }

  const rel  = 'openapi.yaml';
  const spec = read(rel);
  if (!spec) { didSkip('API-SPEC-VERSION', `${rel} not found`); return; }

  // Replace the first version: line in the info block
  const patched = spec.replace(
    /^(\s*version:\s*)["']?\d+\.\d+\.\d+["']?/m,
    `$1"${pkgVer}"`
  );

  if (patched === spec) {
    didSkip('API-SPEC-VERSION', 'version line not found in openapi.yaml'); return;
  }

  write(rel, patched);
  didFix('API-SPEC-VERSION', `updated openapi.yaml info.version to ${pkgVer}`, rel);
}

// =============================================================================
// FIX 4 — TST-MISSING
// Generate a minimal Jest/Supertest boilerplate test file for each route
// that is missing a test file under tests/routes/.
// =============================================================================
function fixMissingTests(findings) {
  const missing = findings.filter((f) => f.id === 'TST-MISSING');
  if (missing.length === 0) return;

  for (const f of missing) {
    // f.file is e.g. "src/routes/admin.js"
    const routeFile = f.file;
    if (!routeFile) { didSkip('TST-MISSING', 'no file path in finding'); continue; }

    const name     = path.basename(routeFile, '.js');            // "admin"
    const testRel  = `tests/routes/${name}.test.js`;

    if (fs.existsSync(abs(testRel))) {
      didSkip('TST-MISSING', `${testRel} already exists`); continue;
    }

    // Read the route file to extract registered paths for scaffolding
    const routeSrc = read(routeFile) || '';
    const methods  = [];
    const routeRe  = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = routeRe.exec(routeSrc)) !== null) {
      methods.push({ method: m[1].toUpperCase(), path: m[2] });
    }

    // Determine the Express mount prefix from app.js
    const appSrc   = read('src/app.js') || '';
    const mountRe  = new RegExp(`use\\(['"\`]([^'"\`]+)['"\`]\\s*,\\s*${name}Router`);
    const mountMatch = appSrc.match(mountRe);
    const prefix   = mountMatch ? mountMatch[1] : `/api/v1/${name}`;

    // Build full test paths
    const testCases = methods.map(({ method, path: p }) => {
      const fullPath = prefix + (p === '/' ? '' : p.replace(':id', '1'));
      const verb     = method.toLowerCase();
      const supertest = verb === 'get' || verb === 'delete'
        ? `request(app).${verb}('${fullPath}')`
        : `request(app).${verb}('${fullPath}').send({})`;
      return `
  describe('${method} ${prefix}${p}', () => {
    it('should respond without a 5xx error', async () => {
      const res = await ${supertest};
      expect(res.status).toBeLessThan(500);
    });
  });`;
    }).join('\n');

    const boilerplate =
`const request = require('supertest');
const app = require('../../src/app');

// Auto-generated by ReleaseGuard AI auto-fix engine.
// Replace these smoke tests with meaningful assertions.
describe('${name.charAt(0).toUpperCase() + name.slice(1)} API', () => {
${testCases}
});
`;

    write(testRel, boilerplate);
    didFix('TST-MISSING', `generated boilerplate test file`, testRel);
  }
}

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================

/**
 * Apply all fixable remediations for the given findings array.
 * @param {Array<{severity,id,title,detail,file}>} findings
 * @returns {{ applied: Array, skipped: Array }}
 */
function applyFixes(findings) {
  console.log(BOLD('\n🔧  Auto-Remediation Engine — applying patches…\n'));

  fixAdminAuth(findings);
  fixMethodMismatch(findings);
  fixSpecVersion(findings);
  fixMissingTests(findings);

  console.log();
  return { applied, skipped };
}

module.exports = { applyFixes };
