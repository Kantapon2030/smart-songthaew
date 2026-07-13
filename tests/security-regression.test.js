const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('retired telemetry endpoint returns 410 before legacy code can write', () => {
  const route = server.slice(server.indexOf("app.post('/api/update-location'"), server.indexOf("app.post('/api/v1/ground/telemetry-batch'"));
  assert.match(route, /return res\.status\(410\)\.json/);
  assert.ok(route.indexOf('status(410)') < route.indexOf('db.ref'));
});

test('admin authentication is environment-backed and cookie-based', () => {
  assert.match(server, /ADMIN_PASSWORD_HASH/);
  assert.match(server, /ss_admin_session/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(server, /Admin123/);
});

test('ground command retrieval requires a ground key and acknowledgement endpoint exists', () => {
  const commandRoute = server.slice(server.indexOf("app.get('/api/ground/command'"), server.indexOf("app.post('/api/ground/command/:commandId/ack'"));
  assert.match(commandRoute, /verifyGroundKey/);
  assert.match(server, /app\.post\('\/api\/ground\/command\/:commandId\/ack'/);
});

test('firmware updater UI and package are removed', () => {
  assert.doesNotMatch(adminHtml, /flashManager|esptool|Firmware Manager/i);
  assert.equal(fs.existsSync(path.join(root, 'public', 'js', 'flashManager.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'public', 'firmware', 'manifest.json')), false);
});

test('server runtime is importable without automatically listening', () => {
  assert.match(server, /if \(require\.main === module\) app\.listen/);
  assert.match(server, /module\.exports = app/);
});

test('dependencies use the supported production baseline', () => {
  assert.equal(packageJson.engines.node, '22.x');
  assert.equal(packageJson.dependencies['firebase-admin'], '14.1.0');
  assert.equal(packageJson.dependencies.bcryptjs, '3.0.3');
});
