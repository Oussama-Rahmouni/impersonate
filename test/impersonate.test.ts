/**
 * impersonate tests — pure logic (arg building, header parsing, coherence, profiles).
 * Network/binary paths are exercised by `impersonate doctor`, not CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, parseProfileName, checkHeaderCoherence, uaMajor, parseHeaderDump, buildArgs } from '../src/index.js';

// ── profile parsing ─────────────────────────────────────────────────────────

test('parseProfile: curl_chrome116 → chrome116', () => {
  assert.equal(parseProfile('/opt/tools/curl_chrome116'), 'chrome116');
  assert.equal(parseProfile('/usr/local/bin/curl_firefox110'), 'firefox110');
  assert.equal(parseProfile('/bin/curl-impersonate-chrome'), 'chrome');
  assert.equal(parseProfile('/bin/random-binary'), null);
});

test('parseProfileName: family + version', () => {
  assert.deepEqual(parseProfileName('chrome116'), { family: 'chrome', version: 116 });
  assert.deepEqual(parseProfileName('firefox'), { family: 'firefox', version: null });
});

// ── header dump parsing ─────────────────────────────────────────────────────

test('parseHeaderDump: redirect chain → last block wins', () => {
  const raw = [
    'HTTP/2 301',
    'location: https://example.com/final',
    'x-first: yes',
    '',
    'HTTP/2 200',
    'content-type: text/html',
    'set-cookie: a=1; Path=/',
    'set-cookie: b=2; Path=/',
    '',
  ].join('\r\n');
  const h = parseHeaderDump(raw);
  assert.equal(h['content-type'], 'text/html');
  assert.equal(h['location'], undefined, 'first block discarded');
  assert.ok(h['set-cookie'].includes('a=1') && h['set-cookie'].includes('b=2'), 'repeated set-cookie kept');
});

test('parseHeaderDump: case-insensitive keys, trimmed values', () => {
  const h = parseHeaderDump('HTTP/2 200\r\nContent-Type:   application/json \r\n\r\n');
  assert.equal(h['content-type'], 'application/json');
});

// ── arg building ────────────────────────────────────────────────────────────

test('buildArgs: GET with cookie jar reads AND writes the jar', () => {
  const args = buildArgs('https://x.com', { cookieJar: '/tmp/jar.txt' }, '/tmp/dump');
  const bi = args.indexOf('-b');
  const ci = args.indexOf('-c');
  assert.equal(args[bi + 1], '/tmp/jar.txt');
  assert.equal(args[ci + 1], '/tmp/jar.txt');
});

test('buildArgs: body implies POST, explicit method wins', () => {
  const post = buildArgs('https://x.com', { body: '{"a":1}' }, '/tmp/dump', '/tmp/body');
  const pi = post.indexOf('-X');
  assert.equal(post[pi + 1], 'POST', 'body present → POST');
  assert.ok(post.join(' ').includes('--data-binary @/tmp/body'));

  const put = buildArgs('https://x.com', { body: 'x', method: 'PUT' }, '/tmp/dump', '/tmp/body');
  const xi = put.indexOf('-X');
  assert.equal(put[xi + 1], 'PUT');
});

test('buildArgs: custom headers appended as -H pairs', () => {
  const args = buildArgs('https://x.com', { headers: { 'x-auth': 'tok' } }, '/tmp/dump');
  const hi = args.indexOf('-H');
  assert.equal(args[hi + 1], 'x-auth: tok');
});

// ── coherence guard ─────────────────────────────────────────────────────────

test('coherence: matching UA passes clean', () => {
  const w = checkHeaderCoherence(
    { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36' },
    'chrome116',
  );
  assert.equal(w.length, 0);
});

test('coherence: Firefox UA over chrome profile → contradiction warning', () => {
  const w = checkHeaderCoherence(
    { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:110.0) Gecko/20100101 Firefox/110.0' },
    'chrome116',
  );
  assert.equal(w.length, 1);
  assert.ok(w[0].message.includes('firefox'));
  assert.ok(w[0].message.includes('chrome116'));
});

test('coherence: major version drift beyond ±2 → warning', () => {
  const w = checkHeaderCoherence(
    { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.0.0 Safari/537.36' },
    'chrome116',
  );
  assert.equal(w.length, 1);
  assert.ok(w[0].message.includes('99'));
});

test('coherence: adjacent version (±1) is fine — UA rolls forward faster than binaries', () => {
  const w = checkHeaderCoherence(
    { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36' },
    'chrome116',
  );
  assert.equal(w.length, 0);
});

test('uaMajor: family-specific extraction', () => {
  assert.equal(uaMajor('Mozilla/5.0 Firefox/121.0', 'firefox'), 121);
  assert.equal(uaMajor('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/120.0', 'edge'), 120);
  assert.equal(uaMajor('garbage', 'chrome'), null);
});
