/**
 * signup-slug.unit.spec.ts — RT-1350 slice 3 (design D3): a self-signup tenant gets a
 * SERVER-generated slug (the owner never chooses one), valid for `tenants_slug_format`
 * (`^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$`) and unique through a random suffix.
 */
import { deriveSlug } from "../../src/signups/signup-slug";

const FORMAT = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

describe("deriveSlug", () => {
  it("lower-cases, hyphenates and appends the suffix", () => {
    expect(deriveSlug("Hassan Market", "ab12cd34")).toBe("hassan-market-ab12cd34");
  });

  it("drops accents and symbols and collapses separators", () => {
    expect(deriveSlug("  Café --- Ünïcode & Co.  ", "ab12cd34")).toBe("cafe-unicode-co-ab12cd34");
  });

  it("falls back to `workspace` when nothing ASCII is left (an Arabic-only business name)", () => {
    expect(deriveSlug("متجر حسن", "ab12cd34")).toBe("workspace-ab12cd34");
  });

  it("keeps the slug within 63 characters for a very long name", () => {
    const slug = deriveSlug("x".repeat(200), "ab12cd34");
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug).toMatch(FORMAT);
  });

  it("never ends or starts with a hyphen and always matches the DB format", () => {
    for (const name of ["-a-", "___", "A", "1", "a b", "!!!"]) {
      expect(deriveSlug(name, "00ff00ff")).toMatch(FORMAT);
    }
  });

  it("uses a random suffix by default, so two calls differ", () => {
    expect(deriveSlug("Same Name")).not.toBe(deriveSlug("Same Name"));
  });
});
