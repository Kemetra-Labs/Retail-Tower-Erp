import type { Page } from "@playwright/test";

/**
 * RT-1304: the mocked Backend-Core and the stubbed S3 origin for the Download POS specs
 * (`download-pos.spec.ts`) and the CI captures (`tests/captures/download-pos.capture.ts`).
 * No live backend and no real S3: the resolver answer is scripted per test, and the S3 origin
 * answers either with an attachment (success) or with a 403 XML page and no attachment header
 * (an expired link), the case the hand-off must keep out of the Console tab (spec AC 9).
 */

const S3_ORIGIN = "https://pilot-bucket.s3.eu-central-1.amazonaws.com";
const SIGNED_URL = `${S3_ORIGIN}/POS-Pulse-Setup-0.3.7.exe?X-Amz-Signature=SENTINELSECRET`;
export const SECRET_MARK = "SENTINELSECRET";
export const SHA = "ab12cd34".repeat(8);

/** The Caddy Console CSP plus the `frame-src` RT-1305 adds when the host sets the bucket. */
const BASE_CSP =
  "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
export const CSP_WITH_FRAME = `${BASE_CSP}; frame-src ${S3_ORIGIN}`;
export const CSP_WITHOUT_FRAME = BASE_CSP;

export const RELEASE = {
  available: true,
  version: "0.3.7",
  sha256: SHA,
  sizeBytes: 185_500_000,
  fileName: "POS-Pulse-Setup-0.3.7.exe",
  expectedPublisher: "CN=Kemetra POS PILOT",
  downloadUrl: SIGNED_URL,
  expiresAt: "2026-11-09T20:00:00Z",
};

interface Latest {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export const envelope = (code: string, requestId = "req-9") => ({
  error: { code, message: "message", request_id: requestId },
});

export function context(role: string, extra: Record<string, unknown> = {}) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
    ...extra,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  status,
  contentType: "application/json",
  headers,
  body: JSON.stringify(body),
});

export interface DownloadMocks {
  /** Requests that reached the resolver. */
  resolverCalls: () => number;
  /** URLs that reached the S3 stub. */
  s3Requests: () => string[];
}

export interface MockOptions {
  role?: string;
  ctx?: Record<string, unknown>;
  /** The resolver's answer; a function sees the 1-based call number. */
  latest?: Latest | ((call: number) => Latest);
  /** How the S3 stub answers a link: a download, or an expired-link error page. */
  s3?: "attachment" | "expired";
  /** Hold the resolver's answer this long (a visible busy state, a real busy window). */
  delayMs?: number;
  /** The resolver never answers: the request is aborted (S9). */
  abort?: boolean;
  /** Header to put on the page document, to run the page under a real-shape CSP. */
  csp?: string;
}

const EXPIRED_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>';

export async function mockDownloadPos(page: Page, opts: MockOptions = {}): Promise<DownloadMocks> {
  let calls = 0;
  const s3: string[] = [];
  const answer = opts.latest ?? { status: 200, body: RELEASE };

  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill(json(opts.ctx ?? context(opts.role ?? "owner"))),
  );
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([])));
  await page.route("**/api/v1/pos-pilot-releases/latest", async (r) => {
    calls += 1;
    if (opts.abort) return r.abort("failed");
    const next = typeof answer === "function" ? answer(calls) : answer;
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    return r.fulfill(json(next.body ?? {}, next.status, next.headers));
  });
  await page.route(`${S3_ORIGIN}/**`, (r) => {
    s3.push(r.request().url());
    if (opts.s3 === "expired") {
      return r.fulfill({ status: 403, contentType: "application/xml", body: EXPIRED_XML });
    }
    return r.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { "content-disposition": 'attachment; filename="POS-Pulse-Setup-0.3.7.exe"' },
      body: "MZ-stub",
    });
  });
  if (opts.csp) {
    const csp = opts.csp;
    await page.route("**/devices/download-pos", async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": csp },
      });
    });
  }
  return { resolverCalls: () => calls, s3Requests: () => s3 };
}

/** Records `securitypolicyviolation` events so a spec can assert on the directive. */
export async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: { directive: string; blocked: string }[] = [];
    (window as unknown as { __csp: typeof log }).__csp = log;
    document.addEventListener("securitypolicyviolation", (e) => {
      log.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
    });
  });
}

export const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: { directive: string }[] }).__csp);
