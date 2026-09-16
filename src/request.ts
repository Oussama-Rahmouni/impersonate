/**
 * REQUEST ENGINE — curl-impersonate as a library.
 *
 * Ported from a production crawler wrapper. The details that make it production-grade
 * instead of a toy exec():
 *
 *   - response headers dumped to a temp file (-D), never mixed with body on stdout
 *   - status captured via --write-out sentinel, not exit-code guessing
 *   - request body via temp file (--data-binary @file) — large/JSON/binary-safe
 *   - cookie jar read AND written (-b + -c) so sessions accumulate trust
 *   - redirect chains visible in the header dump; last block wins for headers
 *   - coherence guard: caller headers are checked against the TLS profile and
 *     contradictions are returned as warnings (throw or log — caller decides)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, verify, parseProfile } from './binaries.js';
import { checkHeaderCoherence, type CoherenceWarning } from './coherence.js';

const execFileAsync = promisify(execFile);

export interface ImpersonateResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** coherence warnings raised by caller headers vs the TLS profile */
  warnings: CoherenceWarning[];
  /** the binary that served the request */
  bin: string;
  /** e.g. "chrome116" */
  profile: string | null;
}

export interface ImpersonateRequestOpts {
  /** explicit binary path; otherwise discovery runs */
  bin?: string;
  /** preferred profile ("chrome116", "firefox") used during discovery */
  profile?: string;
  headers?: Record<string, string>;
  /** path to a cookie jar file; reused (-b) + written (-c) for session continuity */
  cookieJar?: string;
  timeoutSec?: number;
  method?: string;
  /** request body; sent via --data-binary from a temp file */
  body?: string;
  /** throw instead of warn when headers contradict the TLS profile */
  strictCoherence?: boolean;
}

/** Parse a -D header dump. A redirect chain produces multiple blocks; last block wins. */
export function parseHeaderDump(raw: string): Record<string, string> {
  const blocks: string[][] = [[]];
  for (const line of raw.split(/\r?\n/)) {
    if (/^HTTP\//i.test(line)) blocks.push([]);
    else if (line.trim() !== '') blocks[blocks.length - 1].push(line);
  }
  const headers: Record<string, string> = {};
  for (const line of blocks[blocks.length - 1] ?? []) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    // set-cookie can repeat — keep them all, newline-joined
    headers[k] = k === 'set-cookie' && headers[k] ? `${headers[k]}\n${v}` : v;
  }
  return headers;
}

/** Build the curl-impersonate argument list. Exported for tests. */
export function buildArgs(
  url: string,
  opts: ImpersonateRequestOpts,
  dumpFile: string,
  bodyFile?: string,
): string[] {
  const timeoutSec = opts.timeoutSec ?? 25;
  const method = (opts.method ?? (opts.body != null ? 'POST' : 'GET')).toUpperCase();
  const args = [
    '--silent', '--show-error', '--location', '--compressed', '--http2',
    '--max-time', String(timeoutSec),
    '--dump-header', dumpFile,
    '--write-out', '\n__STATUS__%{http_code}',
  ];
  if (method !== 'GET') args.push('-X', method);
  if (bodyFile) args.push('--data-binary', `@${bodyFile}`);
  if (opts.cookieJar) args.push('-b', opts.cookieJar, '-c', opts.cookieJar);
  for (const [k, v] of Object.entries(opts.headers ?? {})) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return args;
}

export async function impersonateRequest(
  url: string,
  opts: ImpersonateRequestOpts = {},
): Promise<ImpersonateResponse> {
  const bin = opts.bin ?? (await discover(opts.profile))?.path;
  if (!bin) {
    throw new Error(
      'no working curl-impersonate binary found. Set CURL_IMPERSONATE_BIN, put curl_chrome* on PATH, or run `impersonate doctor` to diagnose.',
    );
  }
  const v = await verify(bin);
  if (!v.ok) {
    throw new Error(`curl-impersonate binary failed verification: ${v.error}${v.fix ? ` — fix: ${v.fix}` : ''}`);
  }

  const profile = parseProfile(bin);
  const warnings = profile ? checkHeaderCoherence(opts.headers ?? {}, profile) : [];
  if (warnings.length > 0 && opts.strictCoherence) {
    throw new Error(`header/TLS incoherence: ${warnings.map((w) => w.message).join('; ')}`);
  }

  const timeoutSec = opts.timeoutSec ?? 25;
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dumpFile = path.join(os.tmpdir(), `imp-hdr-${tag}.txt`);
  const bodyFile = opts.body != null ? path.join(os.tmpdir(), `imp-body-${tag}.bin`) : undefined;
  if (bodyFile) fs.writeFileSync(bodyFile, opts.body as string);

  const args = buildArgs(url, opts, dumpFile, bodyFile);

  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutSec * 1000 + 3000,
    });
    const m = stdout.match(/\n__STATUS__(\d+)$/);
    const statusCode = m ? parseInt(m[1], 10) : 0;
    const body = stdout.replace(/\n__STATUS__\d+$/, '');
    let headers: Record<string, string> = {};
    try { headers = parseHeaderDump(fs.readFileSync(dumpFile, 'utf8')); } catch { /* no header file */ }
    return { statusCode, headers, body, warnings, bin, profile };
  } finally {
    fs.promises.unlink(dumpFile).catch(() => {});
    if (bodyFile) fs.promises.unlink(bodyFile).catch(() => {});
  }
}

/** Convenience: GET, body + status only. */
export async function impersonateGet(
  url: string,
  opts: ImpersonateRequestOpts = {},
): Promise<{ statusCode: number; body: string }> {
  const r = await impersonateRequest(url, { ...opts, method: 'GET' });
  return { statusCode: r.statusCode, body: r.body };
}
