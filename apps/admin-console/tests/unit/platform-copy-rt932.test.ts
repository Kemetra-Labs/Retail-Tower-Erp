import { describe, expect, test } from "vitest";

import { tFor } from "@/i18n";

/** RT-932: the Arabic copy of the directory and start-drawer items, as the page reads it. */
describe("RT-932 Arabic copy", () => {
  const ar = tFor("ar");
  const params = { tenant: "Delta", purpose: "حادثة", ticket: "SUP-1" };

  test("the replace warning names tenant, purpose and ticket; the no-ticket form drops the clause", () => {
    expect(ar("platform.start.replaces", params)).toBe(
      "بدء هذه الجلسة يُنهي جلستك الحالية في Delta (الغرض: حادثة، التذكرة: SUP-1). لن يتغير شيء في تلك المؤسسة.",
    );
    expect(ar("platform.start.replacesNoTicket", params)).toBe(
      "بدء هذه الجلسة يُنهي جلستك الحالية في Delta (الغرض: حادثة). لن يتغير شيء في تلك المؤسسة.",
    );
  });

  test("clear search, and the ticket faults, read as proposed", () => {
    expect(ar("platform.tenants.search.clear")).toBe("مسح البحث");
    expect(ar("platform.start.ticket.invalid.space")).toBe("مرجع التذكرة يحتوي على مسافة.");
  });

  test("the member action is the directory's «فتح المؤسسة»", () => {
    expect(ar("platform.tenants.action.switch")).toBe("فتح المؤسسة");
  });
});
