// @vitest-environment node
// Release tooling runs in Node (it imports Vite's loadEnv, whose esbuild
// dependency refuses to load under jsdom).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHORT_SHA_LENGTH,
  artifactName,
  buildVersionInfo,
  checkDistLayout,
  releaseBuildEnv,
  sameOriginProblems,
} from "../../release-artifact";

// RT-337: pinned Admin Console release artifact. These cover the pure release
// rules; the CLI wrapper only reads the filesystem and writes version.json.

const SHA = "fcef103e32f14e939bfc03bf370b9f5198311439";
const PIN = "7597a8741d754ce61d28977cc634633d4ed12f80";
const BUILT_AT = "2026-10-09T13:00:00.000Z";

describe("buildVersionInfo", () => {
  it("returns exactly the documented version.json fields", () => {
    const info = buildVersionInfo({ sha: SHA, builtAt: BUILT_AT, backendContractPin: PIN });

    expect(info).toEqual({
      app: "retail-tower-console",
      sha: SHA,
      builtAt: BUILT_AT,
      backendContractPin: PIN,
    });
  });

  it("rejects a SHA that is not a full 40-character lowercase hex commit id", () => {
    for (const sha of ["fcef103", SHA.toUpperCase(), `${SHA}0`, "", "not-a-sha"]) {
      expect(() => buildVersionInfo({ sha, builtAt: BUILT_AT, backendContractPin: PIN })).toThrow(
        /sha/i,
      );
    }
  });

  it("rejects a build time that is not an ISO-8601 UTC timestamp", () => {
    for (const builtAt of ["", "yesterday", "2026-10-09"]) {
      expect(() => buildVersionInfo({ sha: SHA, builtAt, backendContractPin: PIN })).toThrow(
        /builtAt/,
      );
    }
  });

  it("rejects a backend contract pin that is not a hex commit id", () => {
    for (const backendContractPin of ["", "main", "62d09"]) {
      expect(() => buildVersionInfo({ sha: SHA, builtAt: BUILT_AT, backendContractPin })).toThrow(
        /pin/i,
      );
    }
  });
});

describe("artifact naming", () => {
  it("names a release archive after the admin-console/vX.Y.Z tag it is published under (RT-717)", () => {
    expect(artifactName({ tag: "admin-console/v0.1.0", sha: SHA })).toBe(
      "admin-console-v0.1.0.tar.gz",
    );
    expect(artifactName({ tag: "admin-console/v12.3.45", sha: SHA })).toBe(
      "admin-console-v12.3.45.tar.gz",
    );
  });

  it("names a dry-run archive after the fixed-length short SHA, since a dry-run has no tag", () => {
    const short = SHA.slice(0, SHORT_SHA_LENGTH);

    expect(SHORT_SHA_LENGTH).toBe(12);
    expect(artifactName({ sha: SHA })).toBe(`admin-console-dist-${short}.tar.gz`);
    expect(artifactName({ tag: "", sha: SHA })).toBe(`admin-console-dist-${short}.tar.gz`);
  });

  it("refuses a release tag that is not admin-console/vX.Y.Z, including the retired SHA form", () => {
    for (const tag of [
      "admin-console-fcef103e32f1",
      "backend-core/v0.1.0",
      "admin-console/v0.1",
      "admin-console/v0.1.0-rc1",
      "admin-console/0.1.0",
      "refs/tags/admin-console/v0.1.0",
    ]) {
      expect(() => artifactName({ tag, sha: SHA })).toThrow(/admin-console\/vX\.Y\.Z/);
    }
  });

  it("refuses to name an artifact for an invalid SHA", () => {
    expect(() => artifactName({ sha: "fcef103" })).toThrow(/sha/i);
    expect(() => artifactName({ tag: "admin-console/v0.1.0", sha: "fcef103" })).toThrow(/sha/i);
  });
});

describe("checkDistLayout", () => {
  const good = ["index.html", "assets/index-a1b2c3.js", "assets/index-d4e5f6.css"];

  it("accepts a Vite SPA build with index.html and hashed assets", () => {
    expect(checkDistLayout(good)).toEqual([]);
  });

  it("reports a missing index.html", () => {
    expect(checkDistLayout(good.filter((f) => f !== "index.html"))).toEqual([
      "dist/index.html is missing",
    ]);
  });

  it("reports an empty assets directory", () => {
    expect(checkDistLayout(["index.html"])).toEqual(["dist/assets/ contains no files"]);
  });

  it("reports source maps and env files that must never ship", () => {
    expect(checkDistLayout([...good, "assets/index-a1b2c3.js.map", ".env.production"])).toEqual([
      "forbidden file in artifact: assets/index-a1b2c3.js.map",
      "forbidden file in artifact: .env.production",
    ]);
  });

  it("reports a version.json that already exists before the release step writes it", () => {
    expect(checkDistLayout([...good, "version.json"])).toEqual([
      "dist/version.json already exists; it must be written by the release step only",
    ]);
  });
});

describe("sameOriginProblems", () => {
  it("passes when VITE_API_BASE_URL is not set, so the bundle calls the API same-origin", () => {
    expect(sameOriginProblems({})).toEqual([]);
  });

  it("fails when VITE_API_BASE_URL is set to any value during a release build", () => {
    for (const value of ["https://api.example.test", "/", ""]) {
      expect(sameOriginProblems({ VITE_API_BASE_URL: value })).toEqual([
        "VITE_API_BASE_URL must not be set for a release build (same-origin hosting, RT-315)",
      ]);
    }
  });
});

describe("releaseBuildEnv", () => {
  function withRoot(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "rt337-env-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, name), content, "utf8");
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("sees VITE_API_BASE_URL from a root .env.production that vite build would inline", () => {
    withRoot({ ".env.production": "VITE_API_BASE_URL=https://api.example.test\n" }, (root) => {
      expect(sameOriginProblems(releaseBuildEnv(root))).toEqual([
        "VITE_API_BASE_URL must not be set for a release build (same-origin hosting, RT-315)",
      ]);
    });
  });

  it("passes when no root env file sets VITE_API_BASE_URL", () => {
    withRoot({ ".env": "VITE_UNRELATED=1\n" }, (root) => {
      expect(sameOriginProblems(releaseBuildEnv(root))).toEqual([]);
    });
  });
});
