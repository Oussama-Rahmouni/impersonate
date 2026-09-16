/**
 * BINARY DISCOVERY + VERIFICATION.
 *
 * curl-impersonate is distributed as wrapper scripts (curl_chrome116, curl_firefox110…)
 * around a patched libcurl. Two production failure modes this module exists to kill:
 *
 *   1. "binary not found" — the wrapper lives somewhere non-obvious and every
 *      environment (dev laptop, VPS, container) puts it somewhere else.
 *   2. THE SILENT BREAK — the wrapper script runs, but the shared libs it needs
 *      (patched libcurl, BoringSSL) aren't on the loader path. The process exits
 *      non-zero with a loader error and your crawler just... gets Go-looking TLS.
 *      Fix is `LD_LIBRARY_PATH=<impersonate lib dir>`, but only if you KNOW that.
 *      verify() detects this and tells you the fix instead of failing silently.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface BinaryInfo {
  /** path to the wrapper script or binary */
  path: string;
  /** e.g. "chrome116" parsed from curl_chrome116 */
  profile: string | null;
  /** how it was found */
  source: 'env' | 'path' | 'scan';
}

const WRAPPER_RE = /^(curl-impersonate-\w+|curl_(chrome|firefox|edge|safari)\w*)$/;

export function parseProfile(binPath: string): string | null {
  const base = path.basename(binPath);
  const m = base.match(/^curl_(chrome|firefox|edge|safari)(.+)$/) ?? base.match(/^curl-impersonate-(\w+)$/);
  if (!m) return null;
  return m[2] !== undefined && m[1] !== 'impersonate' && base.startsWith('curl_')
    ? `${m[1]}${m[2]}`
    : m[1];
}

/** Candidate locations, in priority order. */
export function candidates(env: NodeJS.ProcessEnv = process.env): { path: string; source: BinaryInfo['source'] }[] {
  const out: { path: string; source: BinaryInfo['source'] }[] = [];
  if (env.CURL_IMPERSONATE_BIN) out.push({ path: env.CURL_IMPERSONATE_BIN, source: 'env' });

  // PATH scan for wrapper scripts
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (WRAPPER_RE.test(e) && /(chrome|firefox|edge|safari)/i.test(e)) {
        out.push({ path: path.join(dir, e), source: 'path' });
      }
    }
  }

  // common install dirs
  const home = env.HOME ?? '';
  for (const dir of [
    path.join(home, 'tools/curl-impersonate/chrome'),
    path.join(home, 'tools/curl-impersonate/firefox'),
    '/usr/local/bin',
    '/opt/curl-impersonate',
  ]) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (/^curl_(chrome|firefox|edge|safari)\d/.test(e)) {
        out.push({ path: path.join(dir, e), source: 'scan' });
      }
    }
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  version: string | null;
  error: string | null;
  /** actionable fix when the failure is the shared-library gotcha */
  fix: string | null;
}

/**
 * Run `<bin> --version` and classify the failure if it breaks.
 * Detects the silent LD_LIBRARY_PATH break explicitly.
 */
export async function verify(bin: string): Promise<VerifyResult> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
    const version = stdout.split('\n')[0] ?? null;
    return { ok: true, version, error: null, fix: null };
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}` : String(err);
    if (/ENOENT/.test(msg) && !fs.existsSync(bin)) {
      return { ok: false, version: null, error: 'binary not found', fix: `set CURL_IMPERSONATE_BIN to a curl-impersonate wrapper (curl_chrome116, …)` };
    }
    if (/shared librar|cannot open shared object|\.so/.test(msg) || /No such file or directory/.test(msg)) {
      // The wrapper runs but the patched libs/binary aren't loadable — the classic silent break.
      // Read the wrapper script to find the binary it delegates to, then give a precise fix.
      let detail = '';
      try {
        const script = fs.readFileSync(bin, 'utf8');
        const m = script.match(/"\$dir\/([\w.-]+)"/);
        if (m) {
          const delegate = path.join(path.dirname(bin), m[1]);
          detail = fs.existsSync(delegate)
            ? ` delegate binary exists at ${delegate} — its libs are missing; run \`ldd ${delegate} | grep "not found"\` and export LD_LIBRARY_PATH with the .libs dir`
            : ` delegate binary MISSING: ${delegate} — the wrapper points at a binary that isn't there (wrong machine/checkout?)`;
        }
      } catch { /* not a readable script */ }
      return {
        ok: false,
        version: null,
        error: `wrapper found but its delegate binary or shared libraries are not loadable.${detail}`,
        fix: `inspect the wrapper: ldd on the delegate binary, then export LD_LIBRARY_PATH=<build>/lib/.libs`,
      };
    }
    return { ok: false, version: null, error: msg.slice(0, 300), fix: null };
  }
}

/** Find the first working binary, newest profile first. Returns null if nothing verified. */
export async function discover(preferProfile?: string): Promise<BinaryInfo | null> {
  // Family priority without an explicit preference: chrome is the fingerprint most
  // sites are calibrated to accept; safari last (its TLS stack diverges most).
  const FAMILY_RANK: Record<string, number> = { chrome: 0, firefox: 1, edge: 2, safari: 3 };
  const all = candidates().sort((a, b) => {
    const pa = parseProfile(a.path) ?? '';
    const pb = parseProfile(b.path) ?? '';
    const fa = FAMILY_RANK[pa.replace(/\d.*/, '')] ?? 9;
    const fb = FAMILY_RANK[pb.replace(/\d.*/, '')] ?? 9;
    if (fa !== fb) return fa - fb;
    const va = parseInt(pa.replace(/\D/g, ''), 10) || 0;
    const vb = parseInt(pb.replace(/\D/g, ''), 10) || 0;
    return vb - va;
  });
  const ordered = preferProfile
    ? [...all.filter((c) => c.path.includes(preferProfile)), ...all.filter((c) => !c.path.includes(preferProfile))]
    : all;
  for (const c of ordered) {
    const v = await verify(c.path);
    if (v.ok) return { path: c.path, profile: parseProfile(c.path), source: c.source };
  }
  return null;
}
