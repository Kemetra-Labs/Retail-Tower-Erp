/**
 * RT-1019 — the Audit band and results panel in a real layout. The band holds
 * its height (one title, one scope line, the UTC note) with a very long
 * unbroken tenant name; the note stays inside the band; the page never scrolls
 * sideways at 1280, 900 or 390; the rows and the drawer still show the times
 * as recorded, in UTC.
 */
import { context, mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/** Wider than a phone at any font: it can only fit by wrapping or clipping. */
const UNBROKEN = "مؤسسةالنيلللتجزئةوالتوزيعالتجمعالخامسالقاهرةالجديدة".repeat(2);

const ROWS = [
  {
    id: "e1",
    occurred_at: "2026-10-30T10:11:56Z",
    action: "platform.cross_tenant.accessed",
    actor_user_id: "c91e2a07-44b8-4d61-9f0a-7a3e15b2c8d4",
    store_id: "8f3b1c2e-6a0d-4e57-9c14-2b7d5e0a9f63",
    target_type: "tenant",
    target_id: "5d0f6e13-8a29-4c7b-b1e4-93a20c7f6d51",
    request_id: "req_01JBX2R5K8VD",
    metadata: { outcome: "rejected", reason: "scope_not_granted" },
  },
  {
    id: "e2",
    occurred_at: "2026-10-29T19:05:44.019Z",
    action: "shift.closed",
    actor_user_id: "1d7e33b9-0c52-4a8e-b6f1-5e29d4a7c013",
    store_id: "8f3b1c2e-6a0d-4e57-9c14-2b7d5e0a9f63",
    request_id: "req_01JBVZ8F2H4N",
  },
];

async function openAudit(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mockRealisticApi(page, {
    ...context,
    active_tenant: { id: "t1", name: UNBROKEN },
    active_store: null,
  });
  await page.route("**/api/v1/audit/events**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: ROWS, next_cursor: null }),
    }),
  );
  await page.goto("/audit");
  await page.locator("header.list-band").waitFor();
}

for (const width of [1280, 900, 390]) {
  test(`${width}: the band holds its shape and the page never scrolls sideways`, async ({
    page,
    t,
  }) => {
    await openAudit(page, width);
    await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
    await expect(page.getByText("shift.closed")).toBeVisible();

    const layout = await page.evaluate(() => {
      const band = document.querySelector("header.list-band") as HTMLElement;
      const box = band.getBoundingClientRect();
      const note = band.querySelector(".audit-band-note") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(note);
      const text = range.getBoundingClientRect();
      return {
        height: Math.round(box.height),
        noteInside: text.left >= box.left - 0.5 && text.right <= box.right + 0.5,
        facts: band.querySelectorAll("dl.list-band__facts").length,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    // A paged list shows no whole-set fact (C1); the note is inside the band.
    expect(layout.facts).toBe(0);
    expect(layout.noteInside).toBe(true);
    expect(layout.pageOverflow).toBe(0);
    if (width >= 1200) expect(layout.height).toBeLessThanOrEqual(132);
  });
}

test("the rows keep UTC times as recorded, and the refused access its words", async ({
  page,
  t,
}) => {
  await openAudit(page, 1280);
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  const table = page.getByRole("table", { name: t("audit.table.caption") });
  await expect(table.getByText("2026-10-30 10:11:56 UTC", { exact: true })).toBeVisible();
  await expect(table.getByText(t("audit.action.crossTenantRefused"))).toBeVisible();
  await expect(page.locator(".audit-table__row--refused")).toHaveCount(1);
});
