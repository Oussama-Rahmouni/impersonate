# impersonate

**curl-impersonate as a real tool — browser TLS fingerprints from Node, without the shell-out footguns.**

```bash
$ impersonate doctor

FAIL /opt/curl-impersonate/curl_chrome116 (via scan)
      wrapper found but its delegate binary or shared libraries are not loadable.
      delegate binary exists at /opt/curl-impersonate/curl-impersonate-chrome — its
      libs are missing; run `ldd … | grep "not found"` and export LD_LIBRARY_PATH…
      fix: inspect the wrapper: ldd on the delegate binary, then export LD_LIBRARY_PATH=<build>/lib/.libs
```

## Why

curl-impersonate gives your scraper a real browser handshake (JA3/JA4, HTTP/2
SETTINGS, GREASE). But using it in production means shelling out to wrapper scripts,
and three footguns eat a day each:

1. **The silent library break.** The wrapper script runs, the patched libcurl isn't
   on the loader path, the process fails — and your fallback quietly sends requests
   with a Node TLS fingerprint. `impersonate doctor` diagnoses this in one command,
   with the actual fix.
2. **Binary sprawl.** Dev laptop, VPS, container — the wrapper lives in a different
   place on each. `impersonate` discovers binaries across env var, PATH, and common
   install dirs, verifies they actually work, and picks the newest.
3. **Incoherent identities.** Override the User-Agent to Chrome/120 while the binary
   presents chrome116's handshake, and the request contradicts itself — anti-bot
   reads both. The coherence guard warns (or throws, `--strict`) when your headers
   disagree with your TLS profile.

## Install

Not on npm yet — install from source:

```bash
git clone https://github.com/Oussama-Rahmouni/impersonate.git
cd impersonate
npm install
npm run build
npm link   # puts `impersonate` on your PATH
```

Requires [curl-impersonate](https://github.com/lwthiker/curl-impersonate) installed
(wrapper scripts like `curl_chrome116`). Point at it with `CURL_IMPERSONATE_BIN`,
put it on PATH, or let discovery find it.

## CLI

```bash
impersonate doctor                                   # diagnose binaries + libraries
impersonate profiles                                 # list discovered profiles
impersonate get <url> --profile chrome116            # fetch with a browser handshake
impersonate get <url> -H "x-api-key: k" --cookie-jar session.jar
impersonate get <url> --json
```

Exit codes: `0` ok · `2` coherence warnings · `1` error.

## Library

```ts
import { impersonateRequest, impersonateGet, discover, verify } from 'impersonate';

const res = await impersonateRequest('https://target.com/api/data', {
  profile: 'chrome116',          // discovery prefers this profile
  cookieJar: './session.jar',    // read AND written — sessions accumulate trust
  headers: { accept: 'application/json' },
  strictCoherence: true,         // throw if my headers contradict the TLS profile
});

res.statusCode;   // 200
res.headers;      // response headers (redirect chain resolved, last block wins)
res.body;
res.warnings;     // coherence warnings, if any
res.profile;      // "chrome116" — the handshake actually used
```

### Cookie jars are the point

`cookieJar` is passed as `-b` **and** `-c`: the jar is read and rewritten every
request, so clearance cookies and session state accumulate exactly like a browser's.
A jar that's been alive for days is worth more than a fresh identity per request.

## What it is not

Not a TLS library — it drives curl-impersonate, which does the actual handshake.
Not a bypass framework — no retry engine, no proxy rotation, no challenge solving.
It's the transport layer those things sit on, done correctly.

Pairs with [ja3lab](https://github.com/Oussama-Rahmouni/ja3lab) (verify the
fingerprint you're presenting) and [whichwaf](https://github.com/Oussama-Rahmouni/whichwaf)
(know what you're up against before choosing a profile).

## License

MIT · [Oussama Rahmouni](https://rahmounidev.com)
