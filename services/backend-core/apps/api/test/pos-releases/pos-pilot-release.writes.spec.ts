/**
 * RT-1298 (RT-1290 slice P2b): the pilot registry writes over HTTP against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool)
 * and the real guards. Only cookie authentication is faked (a header names the
 * session), the presigner is a fake, and the promotion workflow's GitHub OIDC
 * token is signed here with a generated RSA key and verified against a local key
 * set: no network.
 *
 *   POST /api/v1/platform/pos-pilot-releases                          platformRegisterPilotRelease
 *   POST /api/v1/platform/pos-pilot-releases/{releaseId}/withdraw     platformWithdrawPilotRelease
 *   POST /api/v1/platform/pos-pilot-releases/{releaseId}/activate     platformActivatePilotRelease
 *   POST /api/v1/platform/pos-pilot-releases/{releaseId}/supersede-current   platformSupersedeCurrentPilotRelease (RT-1418)
 *
 * What this proves (RT-1298 acceptance 1 and 3 to 6):
 *   - only a genuine token that matches every pin writes: no token, a Console
 *     cookie, an expired token or the wrong audience is 401; other claims, or a
 *     body naming another run, are 403; nothing is written in any of them;
 *   - authentication comes before validation (a bogus body is 401 without a token);
 *   - register follows the contract (201, an equal replay 200 even with
 *     sub-millisecond approval digits, 409 conflicts, 422 for lab, production or a
 *     lab-marked publisher, 400 for a bad body or key), derives the object key,
 *     and audits once, without a token;
 *   - activate is a platform admin on the session cookie, one current release at
 *     a time, withdraw frees the slot, and replays write nothing;
 *   - the whole chain: register, activate, the resolver returns the release,
 *     withdraw, the resolver answers `{ "available": false }`, the next release
 *     can then be activated.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { Module } from "@nestjs/common";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey, type KeyLike } from "jose";
import type { Pool } from "pg";

import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { AuthModule } from "../../src/auth/auth.module";
import { ContextModule } from "../../src/context/context.module";
import type { PilotReleaseConfig } from "../../src/pos-pilot-releases/pilot-release.config";
import { PILOT_RELEASE_CONFIG, PILOT_RELEASE_PRESIGNER } from "../../src/pos-pilot-releases/pilot-release.presigner";
import { PilotReleaseActivationController } from "../../src/pos-pilot-releases/pilot-release-activation.controller";
import { PilotReleaseRegistryService } from "../../src/pos-pilot-releases/pilot-release-registry.service";
import { PilotReleaseWritesController } from "../../src/pos-pilot-releases/pilot-release-writes.controller";
import { PilotReleaseService } from "../../src/pos-pilot-releases/pilot-release.service";
import { PilotReleasesController } from "../../src/pos-pilot-releases/pilot-releases.controller";
import { PilotTenantsController } from "../../src/pos-pilot-releases/pilot-tenants.controller";
import { PilotTenantsService } from "../../src/pos-pilot-releases/pilot-tenants.service";
import {
  GITHUB_OIDC_ISSUER,
  PROMOTION_OIDC_VERIFIER,
  PromotionOidcVerifier,
} from "../../src/pos-pilot-releases/promotion-oidc.verifier";
import type { PromotionOidcConfig } from "../../src/pos-pilot-releases/promotion-oidc.config";
import { PromotionWriterGuard } from "../../src/pos-pilot-releases/promotion-writer.guard";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { OWNER_A, PLATFORM_ADMIN, TENANT_A, seedDeviceHealthFixture } from "../device-health/__support__/device-health-fixture";

const PIN = "CN=Kemetra POS PILOT, O=Kemetra Labs";
const CONFIG: PilotReleaseConfig = { enabled: true, publisher: PIN, bucket: "pilot-bucket", urlTtlSeconds: 300 };
const PINS = {
  enabled: true,
  audience: "retail-tower-backend-core",
  repository: "Kemetra-Labs/Retail-Tower-Erp",
  repositoryId: "1430288487",
  repositoryOwnerId: "340160100",
  environment: "release-pos-pilot-promote",
  ref: "refs/heads/main",
  workflowRef: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
} as const satisfies Extract<PromotionOidcConfig, { enabled: true }>;
const RUN_ID = "987654321";

/** The key set of the test token; assigned in `beforeAll`, read lazily by the verifier. */
let jwks: JWTVerifyGetKey;
let privateKey: KeyLike;
const lazyKeys: JWTVerifyGetKey = (header, token) => jwks(header, token);

const fakePresigner = {
  presignGet: async (request: { bucket: string; key: string; versionId: string }) => ({
    url: `https://${request.bucket}.s3.example/${request.key}?versionId=${request.versionId}&X-Amz-Signature=sig`,
    expiresAt: new Date(Date.now() + 300_000),
  }),
};

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PilotReleasesController, PilotTenantsController, PilotReleaseWritesController, PilotReleaseActivationController],
  providers: [
    { provide: PILOT_RELEASE_CONFIG, useValue: CONFIG },
    { provide: PILOT_RELEASE_PRESIGNER, useValue: fakePresigner },
    { provide: PROMOTION_OIDC_VERIFIER, useValue: new PromotionOidcVerifier(PINS, lazyKeys) },
    PlatformAdminGuard,
    PromotionWriterGuard,
    PilotReleaseService,
    PilotTenantsService,
    PilotReleaseRegistryService,
  ],
})
class PilotReleaseWritesTestModule {}

const h = scopedHttpHarness({
  label: "RT-1298 pilot release writes",
  contractId: "pos-pilot-releases.openapi",
  module: PilotReleaseWritesTestModule,
  seed: seedDeviceHealthFixture,
});

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

const REGISTRY = "/api/v1/platform/pos-pilot-releases";
const LATEST = "/api/v1/pos-pilot-releases/latest";
const withdrawPath = (id: string): string => `${REGISTRY}/${id}/withdraw`;
const activatePath = (id: string): string => `${REGISTRY}/${id}/activate`;
const KEY = "retry-key-0123456789";

/** A promotion token, valid unless an option says otherwise. */
async function token(options: { claims?: Record<string, unknown>; audience?: string; expiresInSeconds?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    repository: PINS.repository,
    repository_id: PINS.repositoryId,
    repository_owner_id: PINS.repositoryOwnerId,
    environment: PINS.environment,
    ref: PINS.ref,
    job_workflow_ref: PINS.workflowRef,
    actor: "kemetra-owner",
    run_id: RUN_ID,
    ...options.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(options.audience ?? PINS.audience)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(privateKey);
}

/** A registration body for one version; the sha and version id follow the version. */
function registration(version = "1.4.0", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    sha256: Buffer.from(version).toString("hex").padEnd(64, "a"),
    sizeBytes: 185483052,
    publisher: PIN,
    signingClass: "pilot",
    attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42",
    sourceSha: "c".repeat(40),
    approvedBy: "kemetra-owner",
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${RUN_ID}`,
    artifactVersionId: `verid-${version}`,
    ...overrides,
  };
}

/** POST with the workflow's token and an idempotency key, unless left out. */
async function post(path: string, body: object, auth: { token?: string | null; key?: string | null } = {}) {
  const bearer = auth.token === undefined ? await token() : auth.token;
  let req = h.post(path, null, body);
  if (bearer !== null) req = req.set("Authorization", `Bearer ${bearer}`);
  if (auth.key !== null) req = req.set("Idempotency-Key", auth.key ?? KEY);
  return req;
}

interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  tenant_id: string | null;
  metadata: Record<string, unknown>;
}

/** The audit rows of one action for one release. */
async function auditsOf(admin: Pool, action: string, releaseId: string): Promise<AuditRow[]> {
  const res = await admin.query<AuditRow>(
    `SELECT actor_user_id, actor_label, tenant_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at, id`,
    [action, releaseId],
  );
  return res.rows;
}

/** How many registry rows exist (superuser, RLS-exempt). */
async function rowCount(admin: Pool): Promise<number> {
  const res = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pos_pilot_release_registry`);
  return Number(res.rows[0]?.n);
}

beforeEach(async () => {
  if (h.skipped()) return;
  const admin = h.env().admin;
  await admin.query(`DELETE FROM pos_pilot_release_registry`);
  await admin.query(`DELETE FROM pos_pilot_tenant_allowlist`);
});

describe("RT-1298 register: only the genuine promotion workflow writes", () => {
  it("authenticates before it validates: a bogus body with no token is 401, with a genuine token 400", async () => {
    if (h.skipped()) return;
    expect((await post(REGISTRY, { bogus: 1 }, { token: null })).status).toBe(401);
    expect((await post(REGISTRY, { bogus: 1 })).status).toBe(400);
    expect(await rowCount(h.env().admin)).toBe(0);
  });

  it("answers 401 for no token, a Console cookie, an expired token and the wrong audience, and writes nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const cases = [
      await post(REGISTRY, registration(), { token: null }),
      await h.post(REGISTRY, PLATFORM_ADMIN.session, registration()).set("Idempotency-Key", KEY),
      await post(REGISTRY, registration(), { token: await token({ expiresInSeconds: -60 }) }),
      await post(REGISTRY, registration(), { token: await token({ audience: "someone-else" }) }),
    ];
    for (const res of cases) {
      expect(res.status).toBe(401);
      h.conforms("Error", res.body);
    }
    expect(await rowCount(admin)).toBe(0);
  });

  it.each([
    ["the repository id (RT-1459)", { repository_id: "999999999" }],
    ["the repository owner id (RT-1459)", { repository_owner_id: "999999999" }],
    ["the environment", { environment: "other-environment" }],
    ["the ref", { ref: "refs/heads/feature" }],
    ["the repository", { repository: "Kemetra-Labs/Other" }],
    ["the workflow", { job_workflow_ref: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/other.yml@refs/heads/main" }],
  ])("answers 403 `forbidden` for a genuine token with another %s, and writes nothing", async (_label, claims) => {
    if (h.skipped()) return;
    const res = await post(REGISTRY, registration(), { token: await token({ claims }) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "forbidden" } });
    expect(await rowCount(h.env().admin)).toBe(0);
  });

  it("answers 403 when the body names another run than the token's, and writes nothing", async () => {
    if (h.skipped()) return;
    const other = registration("1.4.0", { promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/111" });
    const res = await post(REGISTRY, other);
    expect(res.status).toBe(403);
    expect(await rowCount(h.env().admin)).toBe(0);
  });

  it("accepts the token's run named as one of its attempts, and refuses a longer run id that merely starts with it", async () => {
    if (h.skipped()) return;
    const attempt = registration("1.4.0", {
      promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${RUN_ID}/attempts/2`,
    });
    expect((await post(REGISTRY, attempt)).status).toBe(201);
    const prefix = registration("1.5.0", {
      promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${RUN_ID}0`,
    });
    expect((await post(REGISTRY, prefix)).status).toBe(403);
    expect(await rowCount(h.env().admin)).toBe(1);
  });
});

describe("RT-1298 register: the contract's answers", () => {
  it("writes a row (201), derives the object key, and audits once without the token", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const bearer = await token();
    const res = await post(REGISTRY, registration(), { token: bearer });
    expect(res.status).toBe(201);
    h.conforms("PilotRelease", res.body);
    const release = res.body as { releaseId: string; approved: boolean; activatedAt: string | null; signingClass: string };
    expect(release).toMatchObject({ approved: true, activatedAt: null, signingClass: "pilot" });
    const stored = await admin.query<{ artifact_key: string }>(`SELECT artifact_key FROM pos_pilot_release_registry WHERE id = $1`, [release.releaseId]);
    expect(stored.rows[0]?.artifact_key).toBe("pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe");

    const rows = await auditsOf(admin, "pos.pilot_release.registered", release.releaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: null, actor_label: "github-oidc:kemetra-owner", tenant_id: null });
    expect(Object.keys(rows[0]?.metadata ?? {}).sort()).toEqual(
      [
        "approvedAt", "approvedBy", "artifactVersionId", "attestationRef", "promotionRunUrl", "publisher",
        "releaseId", "sha256", "signingClass", "sizeBytes", "sourceSha", "version",
      ].sort(),
    );
    expect(JSON.stringify(rows[0])).not.toContain(bearer);
    expect(JSON.stringify(res.body)).not.toContain(bearer);
  });

  it("answers an equal replay with 200 even when the approval time has sub-millisecond digits", async () => {
    if (h.skipped()) return;
    const body = registration("1.4.0", { approvedAt: "2026-11-09T12:00:00.1239996Z" });
    const first = await post(REGISTRY, body);
    expect(first.status).toBe(201);
    const replay = await post(REGISTRY, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await rowCount(h.env().admin)).toBe(1);
  });

  it("answers an equal replay with 200 and writes nothing more, with the same key or another", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const body = registration();
    const first = await post(REGISTRY, body);
    expect(first.status).toBe(201);
    const id = (first.body as { releaseId: string }).releaseId;
    for (const key of [KEY, "another-key-0123456789"]) {
      const replay = await post(REGISTRY, body, { key });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
    }
    expect(await rowCount(admin)).toBe(1);
    expect(await auditsOf(admin, "pos.pilot_release.registered", id)).toHaveLength(1);
  });

  it("answers 409 `release_conflict` for the same version or sha256 with other values, and never overwrites", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    expect((await post(REGISTRY, registration("1.4.0"))).status).toBe(201);
    expect((await post(REGISTRY, registration("1.5.0"))).status).toBe(201);
    const sameVersion = await post(REGISTRY, registration("1.4.0", { sha256: "f".repeat(64) }));
    const sameSha = await post(REGISTRY, registration("1.6.0", { sha256: registration("1.4.0")["sha256"] }));
    const clashesWithTwo = await post(REGISTRY, registration("1.5.0", { sha256: registration("1.4.0")["sha256"] }));
    for (const res of [sameVersion, sameSha, clashesWithTwo]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "release_conflict" } });
    }
    expect(await rowCount(admin)).toBe(2);
  });

  it.each([
    ["a lab class", { signingClass: "lab" }],
    ["a production class", { signingClass: "production" }],
    ["a lab-marked publisher", { publisher: "CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION" }],
  ])("answers 422 `release_not_pilot` for %s, and writes nothing", async (_label, change) => {
    if (h.skipped()) return;
    const res = await post(REGISTRY, registration("1.4.0", change));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: "release_not_pilot" } });
    expect(await rowCount(h.env().admin)).toBe(0);
  });

  it.each([
    ["a missing idempotency key", registration(), { key: null }],
    ["a malformed idempotency key", registration(), { key: "short" }],
    ["an unknown key in the body", { ...registration(), extra: 1 }, {}],
    ["a version that is not semver", registration("1.4"), {}],
  ])("answers 400 for %s, and writes nothing", async (_label, body, auth) => {
    if (h.skipped()) return;
    const res = await post(REGISTRY, body, auth);
    expect(res.status).toBe(400);
    expect(await rowCount(h.env().admin)).toBe(0);
  });
});

describe("RT-1298 activate, withdraw and the resolver: the whole chain", () => {
  /** Register one version and return its id. */
  async function register(version: string): Promise<string> {
    const res = await post(REGISTRY, registration(version));
    expect(res.status).toBe(201);
    return (res.body as { releaseId: string }).releaseId;
  }

  it("registers, activates, serves the release to an allowlisted tenant, withdraws, and serves nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await h.put(`/api/v1/platform/pos-pilot-tenants/${TENANT_A}`, PLATFORM_ADMIN.session, {});
    const id = await register("1.4.0");

    // Registered is not downloadable.
    expect((await h.get(LATEST, OWNER_A.session)).body).toEqual({ available: false });

    const activated = await h.post(activatePath(id), PLATFORM_ADMIN.session, {});
    expect(activated.status).toBe(200);
    h.conforms("PilotRelease", activated.body);
    expect(activated.body).toMatchObject({ approved: true, activatedByUserId: PLATFORM_ADMIN.id });
    const activations = await auditsOf(admin, "pos.pilot_release.activated", id);
    expect(activations).toHaveLength(1);
    expect(activations[0]).toMatchObject({ actor_user_id: PLATFORM_ADMIN.id, actor_label: null, tenant_id: null });
    expect(activations[0]?.metadata).toEqual({ releaseId: id, version: "1.4.0" });

    // An activation replay writes nothing.
    expect((await h.post(activatePath(id), PLATFORM_ADMIN.session, {})).status).toBe(200);
    expect(await auditsOf(admin, "pos.pilot_release.activated", id)).toHaveLength(1);

    const served = await h.get(LATEST, OWNER_A.session);
    expect(served.body).toMatchObject({ available: true, version: "1.4.0" });
    expect((served.body as { downloadUrl: string }).downloadUrl).toContain("versionId=verid-1.4.0");

    const withdrawn = await post(withdrawPath(id), {});
    expect(withdrawn.status).toBe(200);
    h.conforms("PilotRelease", withdrawn.body);
    expect(withdrawn.body).toMatchObject({ approved: false, withdrawnBy: "kemetra-owner" });
    const rows = await auditsOf(admin, "pos.pilot_release.withdrawn", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: null, actor_label: "github-oidc:kemetra-owner" });
    expect(rows[0]?.metadata).toEqual({
      releaseId: id,
      version: "1.4.0",
      withdrawnBy: "kemetra-owner",
      promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${RUN_ID}`,
    });

    // A withdrawal replay writes nothing; the resolver stops at once.
    expect((await post(withdrawPath(id), {})).status).toBe(200);
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", id)).toHaveLength(1);
    expect((await h.get(LATEST, OWNER_A.session)).body).toEqual({ available: false });
  });

  it("keeps at most one release current: a second is refused until the first is withdrawn, a withdrawn one never returns", async () => {
    if (h.skipped()) return;
    const first = await register("1.4.0");
    const second = await register("1.5.0");
    expect((await h.post(activatePath(first), PLATFORM_ADMIN.session, {})).status).toBe(200);

    const refused = await h.post(activatePath(second), PLATFORM_ADMIN.session, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "release_current_exists" } });

    expect((await post(withdrawPath(first), {})).status).toBe(200);
    expect((await h.post(activatePath(second), PLATFORM_ADMIN.session, {})).status).toBe(200);

    const stale = await h.post(activatePath(first), PLATFORM_ADMIN.session, {});
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "release_withdrawn" } });
  });

  it("lets exactly one of two racing activations win: the other is 409 `release_current_exists`, and one audit row is written", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const first = await register("1.4.0");
    const second = await register("1.5.0");
    const results = await Promise.all([
      h.post(activatePath(first), PLATFORM_ADMIN.session, {}),
      h.post(activatePath(second), PLATFORM_ADMIN.session, {}),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const refused = results.find((res) => res.status === 409);
    expect(refused?.body).toMatchObject({ error: { code: "release_current_exists" } });
    const activated = [
      ...(await auditsOf(admin, "pos.pilot_release.activated", first)),
      ...(await auditsOf(admin, "pos.pilot_release.activated", second)),
    ];
    expect(activated).toHaveLength(1);
  });

  it("answers an equal replay of a withdrawn release with 200 and `approved: false`, never re-approving it", async () => {
    if (h.skipped()) return;
    const body = registration("1.4.0");
    const created = await post(REGISTRY, body);
    const id = (created.body as { releaseId: string }).releaseId;
    expect((await post(withdrawPath(id), {})).status).toBe(200);
    const replay = await post(REGISTRY, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ releaseId: id, approved: false });
  });

  it("answers 404 for an unknown release and 400 for a malformed id", async () => {
    if (h.skipped()) return;
    const unknown = "0190f5a2-3b4c-7d8e-9f01-0000000fffff";
    expect((await h.post(activatePath(unknown), PLATFORM_ADMIN.session, {})).status).toBe(404);
    expect((await post(withdrawPath(unknown), {})).status).toBe(404);
    expect((await h.post(activatePath("not-a-uuid"), PLATFORM_ADMIN.session, {})).status).toBe(400);
    expect((await post(withdrawPath("not-a-uuid"), {})).status).toBe(400);
  });

  it("refuses activation to a non-admin (403) and to a bearer without a session (401), and the workflow cannot withdraw without its token", async () => {
    if (h.skipped()) return;
    const id = await register("1.4.0");
    const admin = h.env().admin;
    expect((await h.post(activatePath(id), OWNER_A.session, {})).status).toBe(403);
    const bearerOnly = await h.post(activatePath(id), null, {}).set("Authorization", `Bearer ${await token()}`);
    expect(bearerOnly.status).toBe(401);
    expect((await post(withdrawPath(id), {}, { token: null })).status).toBe(401);
    expect((await h.post(withdrawPath(id), PLATFORM_ADMIN.session, {})).status).toBe(401);
    expect(await auditsOf(admin, "pos.pilot_release.activated", id)).toHaveLength(0);
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", id)).toHaveLength(0);
  });
});

describe("RT-1418 supersede-current: the run that registered a release withdraws the current one, never its own", () => {
  const supersedePath = (id: string): string => `${REGISTRY}/${id}/supersede-current`;
  const OTHER_RUN = "111222333";

  /** Register one version (as this run, or as another run with its own token) and return its id. */
  async function register(version: string, runId = RUN_ID): Promise<string> {
    const body = registration(version, { promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${runId}` });
    const res = await post(REGISTRY, body, { token: await token({ claims: { run_id: runId } }) });
    expect(res.status).toBe(201);
    return (res.body as { releaseId: string }).releaseId;
  }

  /** Activate a release as the platform admin. */
  async function activate(id: string): Promise<void> {
    expect((await h.post(activatePath(id), PLATFORM_ADMIN.session, {})).status).toBe(200);
  }

  /** The id of the current release, or null (superuser read). */
  async function currentId(admin: Pool): Promise<string | null> {
    const res = await admin.query<{ id: string }>(`SELECT id FROM pos_pilot_release_registry WHERE approved AND activated_at IS NOT NULL`);
    return res.rows[0]?.id ?? null;
  }

  it("withdraws the current release (not the keeper), audits it with `supersededBy`, never activates, and a replay writes nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await h.put(`/api/v1/platform/pos-pilot-tenants/${TENANT_A}`, PLATFORM_ADMIN.session, {});
    const old = await register("1.4.0");
    await activate(old);
    const keeper = await register("1.5.0");

    const res = await post(supersedePath(keeper), {}, { key: null });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    h.conforms("PilotReleaseSupersession", res.body);
    expect(res.body).toMatchObject({
      keeper: { releaseId: keeper, version: "1.5.0", approved: true, activatedAt: null, withdrawnAt: null },
      withdrawn: { releaseId: old, version: "1.4.0", approved: false, withdrawnBy: "kemetra-owner" },
    });
    // Nothing is current now, and nothing is served, until a platform admin activates the keeper.
    expect(await currentId(admin)).toBeNull();
    expect((await h.get(LATEST, OWNER_A.session)).body).toEqual({ available: false });

    const rows = await auditsOf(admin, "pos.pilot_release.withdrawn", old);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: null, actor_label: "github-oidc:kemetra-owner", tenant_id: null });
    expect(rows[0]?.metadata).toEqual({
      releaseId: old,
      version: "1.4.0",
      withdrawnBy: "kemetra-owner",
      promotionRunUrl: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/${RUN_ID}`,
      supersededBy: keeper,
    });
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", keeper)).toHaveLength(0);

    // A retry (Re-run failed jobs) finds nothing else current: 200, withdrawn null, nothing written.
    const replay = await post(supersedePath(keeper), {}, { key: null });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ keeper: { releaseId: keeper, approved: true }, withdrawn: null });
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", old)).toHaveLength(1);

    // The admin activates the keeper; a later retry still never touches it.
    await activate(keeper);
    expect((await h.get(LATEST, OWNER_A.session)).body).toMatchObject({ available: true, version: "1.5.0" });
    const afterActivation = await post(supersedePath(keeper), {}, { key: null });
    expect(afterActivation.status).toBe(200);
    expect(afterActivation.body).toMatchObject({ keeper: { releaseId: keeper, approved: true }, withdrawn: null });
    expect(await currentId(admin)).toBe(keeper);
  });

  it("races a Console activation of the keeper safely: the old release is withdrawn, the keeper never is, at most one is current", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const old = await register("1.4.0");
    await activate(old);
    const keeper = await register("1.5.0");
    const [activation, supersede] = await Promise.all([
      h.post(activatePath(keeper), PLATFORM_ADMIN.session, {}),
      post(supersedePath(keeper), {}, { key: null }),
    ]);
    expect(supersede.status).toBe(200);
    expect(supersede.body).toMatchObject({ keeper: { releaseId: keeper, approved: true }, withdrawn: { releaseId: old } });
    // The activation either waited for the supersede (200) or ran first and was refused (409); never anything else.
    expect([200, 409]).toContain(activation.status);
    const rows = await admin.query<{ id: string; approved: boolean; activated_at: Date | null }>(
      `SELECT id, approved, activated_at FROM pos_pilot_release_registry`,
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(old)?.approved).toBe(false);
    expect(byId.get(keeper)?.approved).toBe(true);
    expect(rows.rows.filter((row) => row.approved && row.activated_at !== null).length).toBeLessThanOrEqual(1);
    expect(await currentId(admin)).toBe(activation.status === 200 ? keeper : null);
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", keeper)).toHaveLength(0);
  });

  it("answers 200 with `withdrawn: null` and writes nothing when no release is current", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const keeper = await register("1.5.0");
    const res = await post(supersedePath(keeper), {}, { key: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ keeper: { releaseId: keeper, approved: true }, withdrawn: null });
    const all = await admin.query(`SELECT 1 FROM audit_events WHERE action = 'pos.pilot_release.withdrawn' AND target_id = $1`, [keeper]);
    expect(all.rowCount).toBe(0);
  });

  it("answers 409 `release_not_newer` for a keeper that is not strictly newer, and leaves the current release alone", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const current = await register("1.5.0");
    await activate(current);
    const keeper = await register("1.4.9");
    const res = await post(supersedePath(keeper), {}, { key: null });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "release_not_newer" } });
    expect(await currentId(admin)).toBe(current);
    expect(await auditsOf(admin, "pos.pilot_release.withdrawn", current)).toHaveLength(0);
  });

  it("answers 403 `forbidden` for a keeper another run registered, and leaves the current release alone", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const current = await register("1.4.0");
    await activate(current);
    const keeper = await register("1.5.0", OTHER_RUN);
    const res = await post(supersedePath(keeper), {}, { key: null });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "forbidden" } });
    expect(await currentId(admin)).toBe(current);
    // The run that did register it may.
    const own = await post(supersedePath(keeper), {}, { key: null, token: await token({ claims: { run_id: OTHER_RUN } }) });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ withdrawn: { releaseId: current } });
  });

  it("answers 409 `release_withdrawn` for a withdrawn keeper, and leaves the current release alone", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const current = await register("1.4.0");
    await activate(current);
    const keeper = await register("1.5.0");
    expect((await post(withdrawPath(keeper), {})).status).toBe(200);
    const res = await post(supersedePath(keeper), {}, { key: null });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "release_withdrawn" } });
    expect(await currentId(admin)).toBe(current);
  });

  it("answers 404 for an unknown keeper, 400 for a malformed id, and 401 without the workflow's token (a Console cookie included)", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const current = await register("1.4.0");
    await activate(current);
    const keeper = await register("1.5.0");
    expect((await post(supersedePath("0190f5a2-3b4c-7d8e-9f01-0000000fffff"), {}, { key: null })).status).toBe(404);
    expect((await post(supersedePath("not-a-uuid"), {}, { key: null })).status).toBe(400);
    expect((await post(supersedePath(keeper), {}, { key: null, token: null })).status).toBe(401);
    expect((await h.post(supersedePath(keeper), PLATFORM_ADMIN.session, {})).status).toBe(401);
    expect(await currentId(admin)).toBe(current);
  });
});
