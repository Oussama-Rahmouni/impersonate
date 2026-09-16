#!/usr/bin/env node
/**
 * impersonate CLI
 *
 *   impersonate get <url> [-H "K: V"] [--cookie-jar f] [--profile chrome116] [--json]
 *   impersonate doctor      find + verify binaries, show the fix when broken
 *   impersonate profiles    list discovered binaries and their profiles
 *
 * Exit codes: 0 ok · 2 coherence warnings raised · 1 error
 */

import { discover, candidates, verify, parseProfile } from './binaries.js';
import { impersonateRequest } from './request.js';

const ESC = '';
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RESET = `${ESC}[0m`;

function usage(): never {
  console.log(`impersonate — curl-impersonate as a tool, not a shell-out hack

usage:
  impersonate get <url> [-H "K: V" ...] [--cookie-jar <file>] [--profile <name>] [--json]
  impersonate doctor       diagnose binary discovery + shared-library health
  impersonate profiles     list discovered impersonation profiles

environment:
  CURL_IMPERSONATE_BIN     explicit path to a curl-impersonate wrapper`);
  process.exit(0);
}

async function doctor(): Promise<void> {
  console.log(`${BOLD}── impersonate doctor ──${RESET}\n`);
  const all = candidates();
  if (all.length === 0) {
    console.log(`${RED}no candidate binaries found${RESET}`);
    console.log(`${DIM}install curl-impersonate, then set CURL_IMPERSONATE_BIN or put curl_chrome* on PATH${RESET}`);
    process.exit(1);
  }
  let anyOk = false;
  for (const c of all) {
    const v = await verify(c.path);
    const profile = parseProfile(c.path);
    if (v.ok) {
      anyOk = true;
      console.log(`${GREEN}OK${RESET}   ${c.path} ${DIM}(${profile ?? 'unknown profile'}, via ${c.source})${RESET}`);
      console.log(`      ${DIM}${v.version}${RESET}`);
    } else {
      console.log(`${RED}FAIL${RESET} ${c.path} ${DIM}(via ${c.source})${RESET}`);
      console.log(`      ${RED}${v.error}${RESET}`);
      if (v.fix) console.log(`      ${YELLOW}fix: ${v.fix}${RESET}`);
    }
  }
  process.exit(anyOk ? 0 : 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage();

  if (args[0] === 'doctor') return doctor();

  if (args[0] === 'profiles') {
    const all = candidates();
    for (const c of all) console.log(`${parseProfile(c.path) ?? '?'}  ${DIM}${c.path} (${c.source})${RESET}`);
    process.exit(0);
  }

  if (args[0] === 'get') {
    const url = args[1];
    if (!url || url.startsWith('-')) usage();
    const headers: Record<string, string> = {};
    let cookieJar: string | undefined;
    let profile: string | undefined;
    let json = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-H') {
        const h = args[++i];
        const idx = h.indexOf(':');
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      } else if (args[i] === '--cookie-jar') cookieJar = args[++i];
      else if (args[i] === '--profile') profile = args[++i];
      else if (args[i] === '--json') json = true;
    }

    try {
      const r = await impersonateRequest(url, { headers, cookieJar, profile });
      if (json) {
        console.log(JSON.stringify({ statusCode: r.statusCode, headers: r.headers, body: r.body, warnings: r.warnings, profile: r.profile }, null, 2));
      } else {
        for (const w of r.warnings) console.error(`${YELLOW}coherence warning: ${w.message}${RESET}`);
        console.log(`${DIM}${r.profile ?? '?'} · ${r.bin}${RESET}`);
        console.log(`${BOLD}status ${r.statusCode}${RESET}`);
        console.log(r.body);
      }
      process.exit(r.warnings.length > 0 ? 2 : 0);
    } catch (err) {
      console.error(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
      process.exit(1);
    }
  }

  usage();
}

main();
