/**
 * RT-1292: the pilot resolver's decision logic, with fakes for the database and
 * the presigner. The real-Postgres proof is `pos-pilot-release.never-cross.spec.ts`.
 */
import type { PilotReleaseConfig } from "../../src/pos-pilot-releases/pilot-release.config";
import {
  resolveLatestPilotRelease,
  type CurrentPilotRelease,
  type PilotReleaseDeps,
  type PilotReleaseOutcome,
} from "../../src/pos-pilot-releases/pilot-release.resolver";

const PIN = "CN=Kemetra POS PILOT, O=Kemetra Labs";
const ENABLED: PilotReleaseConfig = { enabled: true, publisher: PIN, bucket: "pilot-bucket", urlTtlSeconds: 300 };
const NOW = new Date("2026-11-08T12:00:00.000Z");
const EXPIRES = new Date("2026-11-08T12:05:00.000Z");

const RELEASE: CurrentPilotRelease = {
  id: "0190f5a2-3b4c-7d8e-9f01-23456789abcd",
  version: "1.4.0",
  sha256: "a".repeat(64),
  sizeBytes: 185483052,
  publisher: PIN,
  signingClass: "pilot",
  artifactKey: "pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe",
  artifactVersionId: "3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY",
};

interface Harness {
  readonly deps: PilotReleaseDeps;
  readonly calls: { read: number; presign: unknown[]; issued: CurrentPilotRelease[]; outcomes: PilotReleaseOutcome[] };
}

/** Build the resolver's fake dependencies and the record of every call made through them. */
function harness(overrides: {
  config?: PilotReleaseConfig;
  presigner?: "none" | "ok" | "throws";
  allowlisted?: boolean;
  release?: CurrentPilotRelease | null;
  issuedThrows?: boolean;
}): Harness {
  const calls: Harness["calls"] = { read: 0, presign: [], issued: [], outcomes: [] };
  const mode = overrides.presigner ?? "ok";
  const deps: PilotReleaseDeps = {
    config: overrides.config ?? ENABLED,
    presigner:
      mode === "none"
        ? null
        : {
            presignGet: async (input) => {
              calls.presign.push(input);
              if (mode === "throws") throw new Error("presign failed");
              return { url: "https://bucket.example/obj?sig=abc", expiresAt: EXPIRES };
            },
          },
    readState: async () => {
      calls.read += 1;
      return { allowlisted: overrides.allowlisted ?? true, release: overrides.release === undefined ? RELEASE : overrides.release };
    },
    recordIssued: async (release) => {
      if (overrides.issuedThrows) throw new Error("audit failed");
      calls.issued.push(release);
    },
    recordOutcome: (outcome) => calls.outcomes.push(outcome),
    now: () => NOW,
  };
  return { deps, calls };
}

describe("RT-1292 pilot resolver", () => {
  it("returns the release with exactly the contract fields and a presigned URL naming the pinned version", async () => {
    const { deps, calls } = harness({});
    const body = await resolveLatestPilotRelease(deps);
    expect(body).toEqual({
      available: true,
      version: "1.4.0",
      sha256: "a".repeat(64),
      sizeBytes: 185483052,
      fileName: "POS-Pulse-Setup-1.4.0.exe",
      expectedPublisher: PIN,
      downloadUrl: "https://bucket.example/obj?sig=abc",
      expiresAt: "2026-11-08T12:05:00.000Z",
    });
    expect(calls.presign).toEqual([
      {
        bucket: "pilot-bucket",
        key: "pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe",
        versionId: "3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY",
        fileName: "POS-Pulse-Setup-1.4.0.exe",
        ttlSeconds: 300,
      },
    ]);
    expect(calls.issued).toEqual([RELEASE]);
    expect(calls.outcomes).toEqual(["issued"]);
  });

  const unavailable: ReadonlyArray<readonly [string, Parameters<typeof harness>[0], PilotReleaseOutcome]> = [
    ["the lane is disabled", { config: { enabled: false, reason: "pin_unset" } }, "none_not_configured"],
    ["no presigner is wired", { presigner: "none" }, "none_not_configured"],
    ["the tenant is not allowlisted", { allowlisted: false }, "none_not_allowlisted"],
    ["there is no current release", { release: null }, "none_no_current_release"],
    ["the stored class is not pilot", { release: { ...RELEASE, signingClass: "production" } }, "none_class_mismatch"],
    ["the stored class is lab", { release: { ...RELEASE, signingClass: "lab" } }, "none_class_mismatch"],
    ["the publisher differs from the pin", { release: { ...RELEASE, publisher: "CN=Someone Else" } }, "none_pin_mismatch"],
  ];

  it.each(unavailable)("answers exactly { available: false } when %s", async (_label, overrides, outcome) => {
    const { deps, calls } = harness(overrides);
    const body = await resolveLatestPilotRelease(deps);
    expect(body).toEqual({ available: false });
    expect(Object.keys(body)).toEqual(["available"]);
    expect(calls.presign).toEqual([]);
    expect(calls.issued).toEqual([]);
    expect(calls.outcomes).toEqual([outcome]);
  });

  it("does not read the database when the lane is not configured", async () => {
    const disabled = harness({ config: { enabled: false, reason: "bucket_unset" } });
    await resolveLatestPilotRelease(disabled.deps);
    expect(disabled.calls.read).toBe(0);
    const unwired = harness({ presigner: "none" });
    await resolveLatestPilotRelease(unwired.deps);
    expect(unwired.calls.read).toBe(0);
  });

  it("never presigns for a tenant that is not allowlisted, even when a release is current", async () => {
    const { deps, calls } = harness({ allowlisted: false });
    await resolveLatestPilotRelease(deps);
    expect(calls.presign).toEqual([]);
  });

  it("fails loudly when presigning fails: a broken bucket is never shown as no release", async () => {
    const { deps, calls } = harness({ presigner: "throws" });
    await expect(resolveLatestPilotRelease(deps)).rejects.toThrow("presign failed");
    expect(calls.issued).toEqual([]);
    expect(calls.outcomes).toEqual([]);
  });

  it("fails loudly and returns no URL when the audit row cannot be written", async () => {
    const { deps, calls } = harness({ issuedThrows: true });
    await expect(resolveLatestPilotRelease(deps)).rejects.toThrow("audit failed");
    expect(calls.outcomes).toEqual([]);
  });
});
