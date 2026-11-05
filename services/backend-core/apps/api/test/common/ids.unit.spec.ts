/** RT-1213: the two shared UUID shapes (src/common/ids.ts); each call site keeps its own case rule. */
import { UUID_RE, UUID_RE_I } from "../../src/common/ids";

const LOWER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("UUID_RE / UUID_RE_I", () => {
  it("UUID_RE accepts lower case only", () => {
    expect(UUID_RE.test(LOWER)).toBe(true);
    expect(UUID_RE.test(LOWER.toUpperCase())).toBe(false);
  });

  it("UUID_RE_I accepts either case", () => {
    expect(UUID_RE_I.test(LOWER)).toBe(true);
    expect(UUID_RE_I.test(LOWER.toUpperCase())).toBe(true);
  });

  it.each(["", "nope", `${LOWER} `, ` ${LOWER}`, LOWER.slice(1), `${LOWER}0`, LOWER.replaceAll("-", "")])("refuses %j", (value) => {
    expect(UUID_RE.test(value)).toBe(false);
    expect(UUID_RE_I.test(value)).toBe(false);
  });

  it("carries no global or sticky flag, so test() keeps no state between calls", () => {
    for (const re of [UUID_RE, UUID_RE_I]) {
      expect(re.global).toBe(false);
      expect(re.sticky).toBe(false);
    }
  });
});
