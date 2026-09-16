/**
 * Public API.
 */
export { discover, verify, candidates, parseProfile } from './binaries.js';
export type { BinaryInfo, VerifyResult } from './binaries.js';

export { checkHeaderCoherence, parseProfileName, uaMajor } from './coherence.js';
export type { CoherenceWarning } from './coherence.js';

export { impersonateRequest, impersonateGet, parseHeaderDump, buildArgs } from './request.js';
export type { ImpersonateResponse, ImpersonateRequestOpts } from './request.js';
