'use strict';

/**
 * RT-1294 — pure helpers for the PILOT signing hook.
 *
 * The pilot installer is signed with a self-signed leaf whose subject is exactly PILOT_SUBJECT. The hook
 * refuses every other certificate, in particular the lab certificate (its subject carries the lab markers)
 * and anything that could be a production certificate. A pilot signature is always timestamped (RFC 3161):
 * without a timestamp it would stop validating when the leaf expires. Nothing here talks to the network;
 * signtool does, when the hook runs it.
 *
 * The timestamp URL is http:// or https://. The workflow sets http://timestamp.sectigo.com (Sectigo's
 * documented URL) because the Windows SDK signtool seen on the hosted runner (10.0.26100.0 at the time)
 * rejected the https form with "Invalid Timestamp URL" (RT-1294 dry run 42783687374; owner amendment of
 * RT-1290 P-5, 2026-11-10). The TSA signs the timestamp token, so the transport scheme is not what protects
 * its integrity: a network attacker cannot forge a time. They can block or delay stamping (signing then
 * fails closed) or answer through another publicly trusted TSA, which still yields a valid token.
 */

const PILOT_SUBJECT = 'CN=Kemetra POS PILOT';

// The lab certificate's subject markers (lab-sign-lib.cjs). A subject that carries one is refused first,
// with its own message, even though the exact-match check below would refuse it as well.
const REFUSED_MARKERS = ['LAB TEST', 'NOT FOR PRODUCTION'];

const THUMBPRINT_PATTERN = /^[0-9A-F]{40}$/;

/**
 * Refuses every certificate subject that is not exactly the pilot subject (lab markers first).
 * @param {unknown} subject the subject read from the certificate store
 */
function assertPilotSubject(subject) {
  if (typeof subject !== 'string') {
    throw new Error('refusing to sign: the certificate subject is unknown');
  }
  const upper = subject.toUpperCase();
  for (const marker of REFUSED_MARKERS) {
    if (upper.includes(marker)) {
      throw new Error(
        `refusing to sign: the certificate subject carries the lab marker "${marker}"`,
      );
    }
  }
  if (subject.trim() !== PILOT_SUBJECT) {
    throw new Error(
      `refusing to sign: the certificate subject is not the pilot certificate (must be exactly "${PILOT_SUBJECT}")`,
    );
  }
}

/**
 * Upper-cases a thumbprint and strips whitespace; it must be 40 hex characters.
 * @param {string | undefined} value the raw POS_PILOT_CERT_SHA1 value
 * @returns {string} the normalized thumbprint
 */
function normalizeThumbprint(value) {
  const normalized = (value ?? '').replaceAll(/\s+/g, '').toUpperCase();
  if (!THUMBPRINT_PATTERN.test(normalized)) {
    throw new Error('pilot certificate thumbprint must be 40 hex characters (POS_PILOT_CERT_SHA1)');
  }
  return normalized;
}

/**
 * A pilot signature is always timestamped: the URL must start with http:// or https://, have something after
 * the scheme and contain no whitespace. It is not parsed further; signtool rejects a malformed host itself.
 * @param {string | undefined} url the raw POS_PILOT_TSA_URL value
 * @returns {string} the trimmed URL
 */
function assertTimestampUrl(url) {
  const text = (url ?? '').trim();
  const scheme = /^https?:\/\//.exec(text);
  if (!scheme || /\s/.test(text) || text.length <= scheme[0].length) {
    throw new Error(
      'a pilot signature must be timestamped: POS_PILOT_TSA_URL must be an http or https URL',
    );
  }
  return text;
}

/**
 * The signtool arguments: SHA-256 signature from the CurrentUser\My leaf, RFC 3161 SHA-256 timestamp, file last.
 * @param {{ thumbprint: string, file: string, tsaUrl?: string }} options
 * @returns {string[]} the argument list
 */
function buildSigntoolArgs({ thumbprint, file, tsaUrl }) {
  const tsa = assertTimestampUrl(tsaUrl);
  return [
    'sign',
    '/fd',
    'sha256',
    '/s',
    'My',
    '/sha1',
    normalizeThumbprint(thumbprint),
    '/tr',
    tsa,
    '/td',
    'sha256',
    file,
  ];
}

module.exports = {
  PILOT_SUBJECT,
  assertPilotSubject,
  normalizeThumbprint,
  assertTimestampUrl,
  buildSigntoolArgs,
};
