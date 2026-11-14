import { describe, expect, it } from "vitest";
import type { Deployment } from "../../model/types";
import { newestLabDeployment } from "../useBoard";

// Real Port shape (live, read-only, 2026-11-14): `deployment.environment` is one of
// Production / Staging / Development / Unknown; lab deploy jobs are "Staging" with
// `evidenceType: "lab_job"` and their own `properties.createdAt`.
const dep = (id: string, env: string | undefined, at: string, own?: string, evidence = "lab_job"): Deployment => ({
  identifier: id,
  title: id,
  properties: {
    evidenceType: evidence,
    ...(env === undefined ? {} : { environment: env }),
    ...(own ? { createdAt: own } : {}),
  },
  relations: { service: "backend-core" },
  createdAt: at,
  updatedAt: "2026-11-13T11:00:00Z",
});

describe("newestLabDeployment", () => {
  it("reads Staging (any case) and lab deployments, by their own createdAt", () => {
    expect(
      newestLabDeployment([
        dep("a", "Staging", "2026-11-12T17:53:58Z", "2026-11-12T16:23:02Z"),
        dep("b", "staging", "2026-11-12T17:53:58Z", "2026-11-12T08:27:59Z"),
        dep("c", "lab", "2026-11-11T00:00:00Z"),
      ]),
    ).toBe("2026-11-12T16:23:02Z");
  });

  it("skips Unknown, Production and deployments with no environment, even when newer", () => {
    expect(
      newestLabDeployment([
        dep("s", "Staging", "2026-11-12T00:00:00Z", "2026-11-12T00:00:00Z"),
        dep("u", "Unknown", "2026-11-13T12:00:00Z"),
        dep("p", "Production", "2026-11-13T12:00:00Z"),
        dep("n", undefined, "2026-11-13T12:00:00Z"),
      ]),
    ).toBe("2026-11-12T00:00:00Z");
  });

  it("is no data (null) when only Unknown deployments exist, as most of Port's do", () => {
    expect(newestLabDeployment([dep("u1", "Unknown", "2026-11-13T12:00:00Z"), dep("u2", "Unknown", "2026-11-13T11:00:00Z")])).toBeNull();
    expect(newestLabDeployment([])).toBeNull();
  });

  it("never counts a merge proxy as a deploy, even in Staging and newer", () => {
    expect(
      newestLabDeployment([
        dep("real", "Staging", "2026-11-12T10:00:00Z"),
        dep("proxy", "Staging", "2026-11-13T10:00:00Z", undefined, "merge_proxy"),
      ]),
    ).toBe("2026-11-12T10:00:00Z");
    expect(newestLabDeployment([dep("proxy", "Staging", "2026-11-13T10:00:00Z", undefined, "merge_proxy")])).toBeNull();
  });
});
