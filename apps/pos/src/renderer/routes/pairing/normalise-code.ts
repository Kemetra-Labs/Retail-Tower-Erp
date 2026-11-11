/**
 * RT-1316 Phase 2 — normalise a typed or scanned pairing code before submit.
 *
 * The Console shows its codes grouped (`XXXX-XXXX-XXXX-XXXX`, Phase 1), and an
 * installer may type them in lower case or with spaces. Those all name the same
 * Console code, which is 16 characters from an upper-case alphabet without
 * look-alikes and with no dash (`consoleIssuePairingCode`).
 *
 * The pair contract treats the code as opaque ("send it exactly as entered"),
 * and the owner-run bootstrap CLI issues base64url codes, which are
 * case-sensitive and may contain `-`. The server matches the exact bytes. So
 * the cleaned form is used only when it is exactly a Console-shaped code;
 * anything else is sent as typed, trimmed, as before.
 *
 * Owner decision 2026-11-10 (RT-1316, "Console codes only"). One consequence:
 * an owner-SUPPLIED bootstrap code (`--code`) that becomes 16 Console-alphabet
 * characters once spaces and dashes are removed is sent in that cleaned form,
 * so it no longer matches its stored hash. Bootstrap codes should come from
 * the CLI's `--generate` (24 base64url characters), which never takes that shape
 * in practice. Separators-only input is treated as empty (no valid code is one).
 *
 * Pure: no I/O, and the code is never logged.
 */

/** The Console alphabet (Backend-Core `PAIRING_CODE_ALPHABET`), 16 characters long. */
const CONSOLE_CODE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{16}$/;

/** Group separators an installer may type or paste: any whitespace or dash. */
const SEPARATORS = /[\s\p{Pd}]/gu;

/**
 * Returns the code to send: the upper-cased code with separators removed when
 * that is a Console-shaped code, otherwise the trimmed input unchanged. Input
 * made only of separators returns `''`, so the form shows its empty-input
 * message instead of sending it.
 */
export function normalisePairingCode(raw: string): string {
  const cleaned = raw.replace(SEPARATORS, '').toUpperCase();
  if (cleaned === '') return '';
  return CONSOLE_CODE.test(cleaned) ? cleaned : raw.trim();
}
