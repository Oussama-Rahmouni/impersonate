/**
 * COHERENCE GUARD.
 *
 * The wrapper sets headers that match its TLS profile (sec-ch-ua, UA, accept-*).
 * The moment a caller overrides User-Agent to "Chrome/120" while the binary is
 * chrome116, the request becomes internally contradictory: the handshake says one
 * browser, the headers say another. Anti-bot reads both. This module catches that
 * before the request leaves.
 */

export interface CoherenceWarning {
  header: string;
  claimed: string;
  profileSays: string;
  message: string;
}

/** Extract major version from a UA string for the given family. */
export function uaMajor(ua: string, family: string): number | null {
  const patterns: Record<string, RegExp> = {
    chrome: /Chrome\/(\d+)/,
    firefox: /Firefox\/(\d+)/,
    edge: /Edg\/(\d+)/,
    safari: /Version\/(\d+).*Safari/,
  };
  const m = ua.match(patterns[family] ?? /$^/);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse "chrome116" → { family: 'chrome', version: 116 } */
export function parseProfileName(profile: string): { family: string; version: number | null } {
  const m = profile.match(/^(chrome|firefox|edge|safari)(\d+)?/i);
  if (!m) return { family: profile, version: null };
  return { family: m[1].toLowerCase(), version: m[2] ? parseInt(m[2], 10) : null };
}

/**
 * Check caller-supplied headers against the profile the binary will present.
 * Returns warnings — the caller decides whether to throw, log, or strip.
 */
export function checkHeaderCoherence(
  headers: Record<string, string>,
  profile: string,
): CoherenceWarning[] {
  const { family, version } = parseProfileName(profile);
  const warnings: CoherenceWarning[] = [];

  const ua = Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
  if (ua && version !== null) {
    // which family does the UA actually look like?
    const uaLooksLike =
      /Edg\//.test(ua) ? 'edge'
      : /Firefox\//.test(ua) ? 'firefox'
      : /Chrome\//.test(ua) ? 'chrome'
      : /Version\/\d+.*Safari/.test(ua) ? 'safari'
      : null;

    if (uaLooksLike && uaLooksLike !== family) {
      warnings.push({
        header: 'user-agent',
        claimed: ua.slice(0, 80),
        profileSays: profile,
        message: `UA looks like ${uaLooksLike} but the TLS profile is ${profile} — handshake and headers contradict`,
      });
    } else if (uaLooksLike === family) {
      const claimed = uaMajor(ua, family);
      if (claimed !== null && Math.abs(claimed - version) > 2) {
        warnings.push({
          header: 'user-agent',
          claimed: ua.slice(0, 80),
          profileSays: profile,
          message: `UA claims ${family}/${claimed} but the TLS profile is ${family}${version} — version drift beyond ±2 is a fingerprint mismatch`,
        });
      }
    }
  }

  const secChUa = Object.entries(headers).find(([k]) => k.toLowerCase() === 'sec-ch-ua')?.[1];
  if (secChUa && version !== null && !secChUa.includes(`v="${version}"`) && /chrom(e|ium)/i.test(secChUa) === (family === 'chrome')) {
    const m = secChUa.match(/"Chrome";v="(\d+)"/) ?? secChUa.match(/"Chromium";v="(\d+)"/);
    if (m && Math.abs(parseInt(m[1], 10) - version) > 2) {
      warnings.push({
        header: 'sec-ch-ua',
        claimed: secChUa.slice(0, 80),
        profileSays: profile,
        message: `sec-ch-ua advertises v${m[1]} but the TLS profile is ${profile}`,
      });
    }
  }

  return warnings;
}
