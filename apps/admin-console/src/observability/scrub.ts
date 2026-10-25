/**
 * Sentry `beforeSend` scrubber for the Console (RT-633, OBS-4). Pure and
 * SDK-free so it is unit-testable without a live SDK.
 *
 * Conforms to the Observability contract (RT-629) section 3, using Backend-Core's
 * `packages/shared/src/observability/sentry.ts` (RT-609) as the reference:
 *  - Allowlist rebuild: the outgoing event keeps a short list of safe fields.
 *    `request`, `user`, `extra`, `contexts`, breadcrumbs, `transaction`, frame
 *    `vars` and source lines are dropped wholesale.
 *  - Tags are an allowlist too (contract section 1). Ids (tenant, store, user,
 *    device, sale) and free text are never tags.
 *  - JWTs, URL userinfo/query/fragment, emails and Postgres row values are
 *    masked anywhere in a message, with index scans only (linear time on
 *    untrusted input, no backtracking regex).
 *  - RT-879: also `Bearer`/`Authorization` credentials and phone numbers
 *    (OBS-1 §3.2 as amended by RT-682 and RT-694, pinned by the §3.5 golden
 *    vectors), credential `key=value` pairs, MariaDB `Duplicate entry` values,
 *    and a scan cap that never splits a word: every rule another runtime
 *    masks (shared `rt879-redaction-vectors.json`).
 */

import { maskPhones } from "./phone-mask";

/** Max length of an exception message that leaves the browser. */
const MAX_MESSAGE_LENGTH = 300;
// Bounds the work done on untrusted input before any scanning runs.
const MAX_SCAN_LENGTH = 2000;

/** Contract section 1: the only tags an event may carry, all bounded. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "service",
  "env",
  "version",
  "route",
  "method",
  "status",
  "status_class",
  "queue",
  "job_name",
  "error_class",
  "outcome",
]);

export interface SentryFrameLike {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  module?: string;
  in_app?: boolean;
  [key: string]: unknown;
}

export interface SentryExceptionValueLike {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean; [key: string]: unknown };
  stacktrace?: { frames?: SentryFrameLike[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Structural subset of a Sentry event; only what the scrubber reads or emits. */
export interface SentryEventLike {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  server_name?: string;
  sdk?: { settings?: { infer_ip?: string }; [key: string]: unknown };
  tags?: Record<string, unknown>;
  exception?: { values?: SentryExceptionValueLike[] };
  [key: string]: unknown;
}

const SAFE_TOP_LEVEL = [
  "event_id",
  "timestamp",
  "platform",
  "level",
  "environment",
  "release",
  "server_name",
] as const;

// Postgres echoes row values after these markers ("Key (email)=(a@b.c) already
// exists.", "Failing row contains (1, a@b.c, ...)"). Values may contain
// parentheses, so everything from the marker on is masked (indexOf, no regex).
const POSTGRES_ROW_MARKERS = [
  { marker: "Key (", mask: "Key (...)=(...)" },
  { marker: "Failing row contains (", mask: "Failing row contains (...)" },
] as const;
// MariaDB 1062 `Duplicate entry '<value>' for key '<index>'`: only the value is
// masked (RT-879, the Connector rule).
const DUPLICATE_ENTRY = "Duplicate entry '";
const DUPLICATE_KEY = "' for key ";
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
/** Characters that open a URL query or fragment. */
const QUERY_MARKS: ReadonlySet<string> = new Set(["?", "#"]);
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([`"`, "'", ")", "]", ",", ";", ".", ">"]);
const FRAME_LOCATION_KEYS = ["function", "lineno", "colno", "module", "in_app"] as const;
const MECHANISM_KEYS = ["type", "handled"] as const;
const REDACTED = "[redacted]";
// Characters ignored around `Bearer` and an auth-scheme word (OBS-1 §3.2; RT-694 adds `)]}`).
const WORD_WRAPPERS = `"'{[(,:)]}`;
const QUOTES = `"'`;
const IDENTIFIER_CHAR = /^[a-z0-9_-]$/i;
// A credential key matches as the END of an identifier: `Authorization`,
// `dp2_token`, `client_secret`, `api-key` (RT-879, the Connector rule; OBS-1
// §3.2 requires `authorization`, stricter is allowed).
const CREDENTIAL_SUFFIXES: readonly string[] = [
  "token",
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "dsn",
];
// After `Authorization:`, a scheme word means the credential is the word after it.
const AUTH_SCHEMES: ReadonlySet<string> = new Set([
  "bearer",
  "basic",
  "digest",
  "token",
  "apikey",
  "negotiate",
  "ntlm",
]);

/** Copy only the listed keys whose value is defined. */
function pickDefined<K extends string>(
  source: Partial<Record<K, unknown>>,
  keys: readonly K[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function maskPostgresRowValues(value: string): string {
  let out = value;
  for (const { marker, mask } of POSTGRES_ROW_MARKERS) {
    const at = out.indexOf(marker);
    if (at !== -1) out = `${out.slice(0, at)}${mask}`;
  }
  return out;
}

/** `Duplicate entry '<value>' for key 'x'` -> `Duplicate entry '...' for key 'x'`. */
function maskDuplicateEntry(value: string): string {
  const at = value.indexOf(DUPLICATE_ENTRY);
  if (at === -1) return value;
  const valueStart = at + DUPLICATE_ENTRY.length;
  const keyAt = value.indexOf(DUPLICATE_KEY, valueStart);
  return `${value.slice(0, valueStart)}...${keyAt === -1 ? "'" : value.slice(keyAt)}`;
}

/**
 * The first `MAX_SCAN_LENGTH` chars, cut back to whitespace so the cap never
 * splits a word: a cut `jane@exa` has no dot after its `@` and would dodge the
 * email mask (RT-879, the Connector rule).
 */
function capped(value: string): string {
  if (value.length <= MAX_SCAN_LENGTH) return value;
  let end = MAX_SCAN_LENGTH;
  while (end > 0 && value.charAt(end).trim() !== "") end--;
  // No whitespace at all: keep the hard cut. Inside one word every mask that
  // shortens the text drops the rest of the word, so the cut tail never surfaces.
  return value.slice(0, end > 0 ? end : MAX_SCAN_LENGTH);
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * How to treat the word after this one (OBS-1 §3.2): scrub it as usual, mask it
 * as a credential, or (after a bare credential key, RT-694) take a leading
 * `:`/`=` in it as that key's separator.
 */
type NextWord = "scrub" | "mask" | "keySeparator";

/** A scrubbed word, and how to treat the word after it. */
interface ScrubbedWord {
  text: string;
  next: NextWord;
}

/**
 * One whitespace-delimited token of an exception message. Secrets are masked
 * wherever they sit in it (`token=eyJ…`, `"https://u:p@host/x?api_key=…"`):
 * `Bearer` first, then URLs (userinfo and query), any other query or fragment
 * (scheme-less URLs and paths), credential values (`Authorization`,
 * `password=`, …), JWTs, emails and phones. Index scans only, so the work stays
 * linear on untrusted input.
 */
class MessageToken {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scrubbed(): ScrubbedWord {
    if (this.unwrapped() === "bearer") return { text: REDACTED, next: "mask" };
    const urlOnly = this.withoutUrl();
    const url = urlOnly.withoutQuery();
    const credential = url.maskedCredential();
    // The part before `authorization=` still gets the JWT/email/phone masks.
    const masked = (credential ? new MessageToken(credential.text) : url).withoutJwt();
    const text = masked.isEmailLike() ? "[email]" : maskPhones(masked.text);
    const next = credential?.next ?? this.nextAfterKey();
    // A credential key inside the dropped query (`?authorization=`) still passes its signal on.
    const hidden = urlOnly.maskedCredential();
    return { text, next: hidden ? stricter(next, hidden.next) : next };
  }

  /**
   * The word after a bare credential key (`Authorization : Basic x`, RT-694): a
   * leading `:` or `=` is that key's separator, so the rest of the word is its
   * value. `null` when the word does not start with one.
   */
  separatedValue(): ScrubbedWord | null {
    return this.isSeparator(0) ? this.valueAfter(0) : null;
  }

  /** An auth-scheme word (`Bearer`, `'Basic`): the credential is the next word. */
  isAuthScheme(): boolean {
    return AUTH_SCHEMES.has(this.unwrapped());
  }

  /** A word ending in a credential key (`Authorization`), quotes ignored, waits for a separator word. */
  private nextAfterKey(): NextWord {
    return isCredentialKey(this.keyBefore(this.text.length)) ? "keySeparator" : "scrub";
  }

  /**
   * `Authorization:<value>` / `"authorization":` / `headers.authorization=` /
   * `password=<value>`: the value after the first such separator is masked, or
   * the next word when the value is empty. A scheme value (`Bearer`) means the
   * credential is the next word.
   */
  private maskedCredential(): ScrubbedWord | null {
    for (let sep = 0; sep < this.text.length; sep++) {
      if (this.isSeparator(sep) && isCredentialKey(this.keyBefore(sep))) {
        return this.valueAfter(sep);
      }
    }
    return null;
  }

  /** The value after the separator at `sep` masked, or the next word when it is empty. */
  private valueAfter(sep: number): ScrubbedWord {
    const value = new MessageToken(this.text.slice(sep + 1));
    if (value.text === "") return { text: this.text, next: "mask" };
    return {
      text: `${this.text.slice(0, sep + 1)}${REDACTED}`,
      next: value.isAuthScheme() ? "mask" : "scrub",
    };
  }

  /** Lower-cased, without the wrapper characters around it (`'Bearer` -> `bearer`). */
  private unwrapped(): string {
    let start = 0;
    let end = this.text.length;
    while (start < end && WORD_WRAPPERS.includes(this.text.charAt(start))) start++;
    while (end > start && WORD_WRAPPERS.includes(this.text.charAt(end - 1))) end--;
    return this.text.slice(start, end).toLowerCase();
  }

  private isSeparator(at: number): boolean {
    const char = this.text.charAt(at);
    return char === ":" || char === "=";
  }

  /**
   * Lower-cased identifier ending at `sep`, skipping quotes. The scan stops at
   * the previous separator, so all the scans in one word stay linear.
   */
  private keyBefore(sep: number): string {
    let end = sep;
    while (end > 0 && QUOTES.includes(this.text.charAt(end - 1))) end--;
    let start = end;
    while (start > 0 && IDENTIFIER_CHAR.test(this.text.charAt(start - 1))) start--;
    return this.text.slice(start, end).toLowerCase();
  }

  /** Keep scheme + host + path; drop userinfo, query, fragment. Unparsable -> `[url]`. */
  withoutUrl(): MessageToken {
    const sep = this.text.indexOf("://");
    const start = sep > 0 ? this.schemeStart(sep) : sep;
    if (start < 0 || start === sep) return this;
    const raw = this.text.slice(start);
    const end = new MessageToken(raw).bodyLength();
    const url = parseUrl(raw.slice(0, end));
    const safe = url ? `${url.protocol}//${url.host}${url.pathname}` : "[url]";
    return new MessageToken(`${this.text.slice(0, start)}${safe}${raw.slice(end)}`);
  }

  /**
   * Drop a query or fragment the URL pass did not see (`/v1/x?phone=…`,
   * `host/x#token=…`, `?phone=…`). A `?` or `#` that ends the token, or opens
   * it without any `key=value` ("valid?", "#42"), is not one, so ordinary
   * sentences survive.
   */
  withoutQuery(): MessageToken {
    if (QUERY_MARKS.has(this.text.charAt(0)) && this.text.includes("=")) {
      return new MessageToken("");
    }
    for (let i = 1; i < this.text.length - 1; i++) {
      if (QUERY_MARKS.has(this.text.charAt(i))) return new MessageToken(this.text.slice(0, i));
    }
    return this;
  }

  toString(): string {
    return this.text;
  }

  /** Mask a JWT (even without its signature) and everything after it. */
  private withoutJwt(): MessageToken {
    const at = this.text.indexOf("eyJ");
    if (at === -1 || !this.text.includes(".", at)) return this;
    return new MessageToken(`${this.text.slice(0, at)}[jwt]`);
  }

  private isEmailLike(): boolean {
    const at = this.text.indexOf("@");
    return at > 0 && this.text.includes(".", at);
  }

  /** Index where the URL scheme ending at `sep` (the `://`) starts. */
  private schemeStart(sep: number): number {
    let start = sep;
    while (start > 0 && SCHEME_CHAR.test(this.text.charAt(start - 1))) start--;
    return start;
  }

  /** Length without trailing quotes/brackets/punctuation. */
  private bodyLength(): number {
    let end = this.text.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(this.text.charAt(end - 1))) end--;
    return end;
  }
}

const NEXT_WORD_RANK: Readonly<Record<NextWord, number>> = {
  scrub: 0,
  keySeparator: 1,
  mask: 2,
};

/** The stricter of two next-word states (mask, then separator, then scrub). */
function stricter(a: NextWord, b: NextWord): NextWord {
  return NEXT_WORD_RANK[a] >= NEXT_WORD_RANK[b] ? a : b;
}

/**
 * One word, scrubbed as the word before it asks (`next`). A word masked or read
 * as a separator value still passes on its own signal (`[Bearer] Authorization: x`,
 * `Authorization :a,authorization= x`), so nothing is masked less than before.
 */
function scrubWord(token: MessageToken, next: NextWord): ScrubbedWord {
  if (next === "mask") {
    return { text: REDACTED, next: token.isAuthScheme() ? "mask" : token.scrubbed().next };
  }
  const separated = next === "keySeparator" ? token.separatedValue() : null;
  if (separated === null) return token.scrubbed();
  return { text: separated.text, next: stricter(separated.next, token.scrubbed().next) };
}

/**
 * Scrub each word, carrying one "next word" state across words (`Bearer <x>`,
 * `Authorization: Basic <x>`, `Authorization : <x>`). Whitespace passes through.
 */
function scrubWords(parts: readonly string[]): string {
  let next: NextWord = "scrub";
  const out: string[] = [];
  for (const part of parts) {
    if (part.trim() === "") {
      out.push(part);
    } else {
      const word = scrubWord(new MessageToken(part), next);
      next = word.next;
      out.push(word.text);
    }
  }
  return out.join("");
}

function sanitizeMessage(value: string): string {
  const words = maskDuplicateEntry(maskPostgresRowValues(capped(value))).split(/(\s+)/);
  const cleaned = scrubWords(words);
  return cleaned.length > MAX_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : cleaned;
}

/** Browser frame filenames are URLs or paths: keep scheme + host + path only. */
function scrubFrame(frame: SentryFrameLike): Record<string, unknown> {
  const out = pickDefined(frame, FRAME_LOCATION_KEYS);
  if (typeof frame.filename === "string") {
    const capped = frame.filename.slice(0, MAX_SCAN_LENGTH);
    out.filename = new MessageToken(capped).withoutUrl().withoutQuery().toString();
  }
  return out;
}

function scrubException(entry: SentryExceptionValueLike): SentryExceptionValueLike {
  const out: SentryExceptionValueLike = {};
  // `type` is `error.name`, which app code can set to any text.
  if (typeof entry.type === "string") out.type = sanitizeMessage(entry.type);
  if (typeof entry.value === "string") out.value = sanitizeMessage(entry.value);
  if (entry.mechanism !== undefined) out.mechanism = pickDefined(entry.mechanism, MECHANISM_KEYS);
  const frames = entry.stacktrace?.frames;
  if (Array.isArray(frames)) out.stacktrace = { frames: frames.map(scrubFrame) };
  return out;
}

function scrubTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value === "string" && ALLOWED_TAGS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * `beforeSend` hook: rebuild the event from allowlisted fields only, or return
 * `null` (drop) when it carries no exception. Pure; does not mutate its input.
 */
export function scrubSentryEvent(event: SentryEventLike): SentryEventLike | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  const out: SentryEventLike = pickDefined(event, SAFE_TOP_LEVEL);
  // Sentry 11 tells ingest whether to infer the end-user IP from the request
  // (sdk.settings.infer_ip). Pinned to "never": contract 3.3 forbids IPs.
  out.sdk = { settings: { infer_ip: "never" } };
  const tags = scrubTags(event.tags);
  if (Object.keys(tags).length > 0) out.tags = tags;
  out.exception = { values: values.map(scrubException) };
  return out;
}
