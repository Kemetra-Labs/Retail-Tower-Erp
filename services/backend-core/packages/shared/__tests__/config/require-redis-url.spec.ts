import { requireRedisUrl } from "../../src/config/require-redis-url";

describe("requireRedisUrl (RT-1212)", () => {
  const saved = { url: process.env["REDIS_URL"], env: process.env["NODE_ENV"] };

  afterEach(() => {
    for (const [key, value] of [
      ["REDIS_URL", saved.url],
      ["NODE_ENV", saved.env],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns the URL when REDIS_URL is set, in any environment", () => {
    process.env["REDIS_URL"] = "redis://r:6379";
    for (const env of ["production", "development", "test"]) {
      process.env["NODE_ENV"] = env;
      expect(requireRedisUrl({ component: "X", reason: "why" })).toBe("redis://r:6379");
    }
  });

  it("throws in production when REDIS_URL is missing, keeping the component prefix and reason", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    expect(() => requireRedisUrl({ component: "AuditModule", reason: "AuditQueueProducer cannot be wired without it" })).toThrow(
      "AuditModule: REDIS_URL is required in production (AuditQueueProducer cannot be wired without it).",
    );
  });

  it("treats an empty REDIS_URL as missing", () => {
    process.env["REDIS_URL"] = "";
    process.env["NODE_ENV"] = "production";
    expect(() => requireRedisUrl({ component: "X", reason: "why" })).toThrow("X: REDIS_URL is required in production");
  });

  it("returns null in non-production when REDIS_URL is missing", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "development";
    expect(requireRedisUrl({ component: "X", reason: "why" })).toBeNull();
  });

  it("runs onMissingDev only on the dev-missing path", () => {
    const onMissingDev = jest.fn();
    process.env["REDIS_URL"] = "redis://r:6379";
    requireRedisUrl({ component: "X", reason: "why", onMissingDev });
    expect(onMissingDev).not.toHaveBeenCalled();

    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    expect(() => requireRedisUrl({ component: "X", reason: "why", onMissingDev })).toThrow();
    expect(onMissingDev).not.toHaveBeenCalled();

    process.env["NODE_ENV"] = "test";
    expect(requireRedisUrl({ component: "X", reason: "why", onMissingDev })).toBeNull();
    expect(onMissingDev).toHaveBeenCalledTimes(1);
  });
});
