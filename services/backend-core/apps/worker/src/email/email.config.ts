/**
 * Email transport configuration — RT-1280.
 *
 * Read once at worker boot from the environment. Production fails closed:
 * a worker that consumes `email` jobs but silently drops them (NoOp) would
 * leave invitees waiting for mail that never comes, so a missing or
 * invalid setting stops the worker instead.
 *
 *   EMAIL_TRANSPORT   `ses` | `noop`. Required in production, where only
 *                     `ses` is accepted. Unset outside production = `noop`.
 *   EMAIL_FROM        Sender address (`ses` only), e.g. no-reply@<domain>.
 *                     The IAM sending identity is pinned to this address.
 *   SES_REGION        AWS region of the verified SES identity (`ses` only).
 *   CONSOLE_BASE_URL  Admin Console origin used to build accept links
 *                     (`https://host`, no path, query or credentials).
 *                     Required with `ses`.
 *
 * AWS credentials: in production `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` must both be present (only presence is checked
 * here). On the lab they come from the root-only secrets file and reach the
 * worker container only; `createSesEmailAdapter` passes them explicitly.
 *
 * Error messages name the variable, never its value.
 */

export const EMAIL_CONFIG = "EMAIL_CONFIG";

export type EmailConfig =
  | { readonly kind: "noop"; readonly consoleBaseUrl: string | null }
  | {
      readonly kind: "ses";
      readonly from: string;
      readonly region: string;
      readonly consoleBaseUrl: string;
    };

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(`Email configuration (RT-1280): ${message}`);
    this.name = "EmailConfigError";
  }
}

// One `local@domain.tld` address with no display name, spaces or angle brackets.
const SENDER_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * The Admin Console origin, or throws. Only an https origin is accepted:
 * accept links carry a one-time token, so they must never point at plain
 * http, a path prefix that could be misrouted, or a URL with credentials.
 */
export function parseConsoleBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmailConfigError("CONSOLE_BASE_URL is not an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new EmailConfigError("CONSOLE_BASE_URL must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new EmailConfigError("CONSOLE_BASE_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new EmailConfigError("CONSOLE_BASE_URL must be an origin only (no path, query or fragment)");
  }
  return url.origin;
}

export function resolveEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const production = env["NODE_ENV"] === "production";
  const transport = readTrimmed(env, "EMAIL_TRANSPORT");
  const rawBaseUrl = readTrimmed(env, "CONSOLE_BASE_URL");

  if (transport === "" || transport === "noop") {
    if (production) {
      throw new EmailConfigError(
        "EMAIL_TRANSPORT=ses is required in production (NoOp would drop every email)",
      );
    }
    return {
      kind: "noop",
      consoleBaseUrl: rawBaseUrl === "" ? null : parseConsoleBaseUrl(rawBaseUrl),
    };
  }

  if (transport !== "ses") {
    throw new EmailConfigError("EMAIL_TRANSPORT must be 'ses' or 'noop'");
  }

  const from = readTrimmed(env, "EMAIL_FROM");
  if (!SENDER_PATTERN.test(from)) {
    throw new EmailConfigError("EMAIL_FROM must be a single sender address");
  }
  const region = readTrimmed(env, "SES_REGION");
  if (!REGION_PATTERN.test(region)) {
    throw new EmailConfigError("SES_REGION must be an AWS region such as us-east-1");
  }
  if (rawBaseUrl === "") {
    throw new EmailConfigError("CONSOLE_BASE_URL is required with EMAIL_TRANSPORT=ses");
  }
  // Production sends only as the SES-send-only IAM user: never fall back to
  // another credential source. Presence is checked here; values are not read.
  if (
    production &&
    (readTrimmed(env, "AWS_ACCESS_KEY_ID") === "" || readTrimmed(env, "AWS_SECRET_ACCESS_KEY") === "")
  ) {
    throw new EmailConfigError(
      "the SES sending key (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) is required in production",
    );
  }
  return { kind: "ses", from, region, consoleBaseUrl: parseConsoleBaseUrl(rawBaseUrl) };
}
