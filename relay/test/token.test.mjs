import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { issueToken, verifyToken, TokenError } from '../token.mjs';

const SECRET = 'test-secret-that-is-long-enough';
const NOW = 1_800_000_000;

function code(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TokenError, `not a TokenError: ${e}`);
    return e.code;
  }
  assert.fail('no error');
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

test('round trip', () => {
  const t = issueToken(SECRET, { doc: 'd1', sub: 'u1', name: 'Ann', role: 'edit' }, NOW);
  const c = verifyToken(SECRET, t, NOW + 10);
  assert.deepEqual([c.doc, c.sub, c.name, c.role], ['d1', 'u1', 'Ann', 'edit']);
  assert.equal(c.exp, NOW + 12 * 3600);
});

test('tampered payload fails the signature', () => {
  const t = issueToken(SECRET, { doc: 'd1', sub: 'u1', name: 'Ann', role: 'view' }, NOW);
  const [h, , s] = t.split('.');
  const forged = [h, b64url({ doc: 'd1', sub: 'u1', name: 'Ann', role: 'edit', iat: NOW, exp: NOW + 60 }), s].join('.');
  assert.equal(code(() => verifyToken(SECRET, forged, NOW)), 'bad-signature');
  assert.equal(code(() => verifyToken('other-secret-also-long-enough', t, NOW)), 'bad-signature');
});

test('expired', () => {
  const t = issueToken(SECRET, { doc: 'd', sub: 'u', name: 'A', role: 'edit', exp: NOW + 60 }, NOW);
  assert.equal(code(() => verifyToken(SECRET, t, NOW + 61)), 'expired');
});

test('longer than 24 hours is refused', () => {
  assert.throws(() => issueToken(SECRET, { doc: 'd', sub: 'u', name: 'A', role: 'edit', exp: NOW + 25 * 3600 }, NOW), TokenError);
  // A token minted elsewhere with a long life is refused on verify too.
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ doc: 'd', sub: 'u', name: 'A', role: 'edit', iat: NOW, exp: NOW + 48 * 3600 });
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(code(() => verifyToken(SECRET, `${header}.${payload}.${sig}`, NOW)), 'too-long-lived');
});

test('alg none and junk are malformed', () => {
  const none = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ doc: 'd', sub: 'u', name: 'A', role: 'edit', iat: NOW, exp: NOW + 60 })}.`;
  assert.equal(code(() => verifyToken(SECRET, none, NOW)), 'malformed');
  assert.equal(code(() => verifyToken(SECRET, 'a.b', NOW)), 'malformed');
  assert.equal(code(() => verifyToken(SECRET, 42, NOW)), 'malformed');
  assert.equal(code(() => verifyToken(SECRET, 'x'.repeat(5000), NOW)), 'malformed');
});

test('missing or bad claims are malformed', () => {
  const t = issueToken(SECRET, { doc: 'd', sub: 'u', name: 'A', role: 'edit' }, NOW);
  assert.ok(t);
  assert.throws(() => issueToken(SECRET, { doc: '', sub: 'u', name: 'A', role: 'edit' }, NOW), TokenError);
  assert.throws(() => issueToken(SECRET, { doc: 'd', sub: 'u', name: 'A', role: 'owner' }, NOW), TokenError);
  assert.throws(() => issueToken('short', { doc: 'd', sub: 'u', name: 'A', role: 'edit' }, NOW), TokenError);
});
