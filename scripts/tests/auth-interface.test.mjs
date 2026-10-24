import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { load } from 'cheerio';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../../supabase/migrations/20261023_private_auth.sql', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const auth = fs.readFileSync(new URL('../../src/auth-multiuser.js', import.meta.url), 'utf8');
const $ = load(html);
assert.equal($('#signup-form').length, 0, 'signup form must not be rendered');
assert.equal($('button[onclick="showSignupForm()"], button[onclick="doSignup()"]').length, 0, 'signup actions must not be present');
assert.match(html, /Acesso exclusivo para usuários autorizados/);
assert.equal($('#admin-nav-section').length, 1);
assert.equal($('#view-admin').length, 1);
assert.match(html, /function applyAuthUser/);
assert.match(html, /cookie-session/);
assert.match(html, /requestPasswordRecovery/);
assert.match(migration, /enable row level security/i);
assert.match(migration, /revoke all on table/i);
assert.match(migration, /complete_user_password_recovery/);
assert.match(migration, /accept_user_invitation/);
assert.doesNotMatch(migration, /drop table/i, 'migration must preserve existing tables');
assert.ok(server.indexOf("app.use('/api', authMiddleware);") < server.indexOf("app.get('/api/health'"), 'health route must run after API auth middleware');
assert.match(server, /const payload = \{ status: 'ok', timestamp: new Date\(\)\.toISOString\(\) \};/);
assert.match(server, /if \(req\.query\.deep === '1'\) \{\s*if \(!isAdmin\) return res\.status\(403\)/);
assert.match(auth, /full === '\/api\/health' && req\.query\?\.deep !== '1'/);

let checked = 0;
for (const element of $('script:not([src])').toArray()) {
  const type = String($(element).attr('type') || '').toLowerCase();
  if (type === 'module' || (type && type !== 'text/javascript' && type !== 'application/javascript')) continue;
  const source = $(element).html() || '';
  if (!source.trim()) continue;
  new vm.Script(source, { filename: `index-inline-${checked + 1}.js` });
  checked += 1;
}
assert.ok(checked >= 5, `expected to parse inline scripts; found ${checked}`);
console.log(`OK — cadastro removido, painel admin presente e ${checked} scripts inline sintaticamente válidos`);
