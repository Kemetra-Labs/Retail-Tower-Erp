import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1601 redistribution proposals E2E against mocked Backend-Core, in both locales (RT-399).
 *
 * J1 (acceptance 2): compute → review a line ("would accept") → accept it into a W3 draft transfer.
 *    A stateful mock plays the RT-1600 runtime; the Console computes nothing, so every quantity and
 *    outcome on screen is one the mock returned. The accept answer drops the second line, so the
 *    screen must show both a created draft (linked to Transfers) and a dropped line with its reason.
 * J2: a tenant with the feature off sees "not available" and no compute control (non-disclosing 404).
 *
 * Set REDISTRIBUTION_EVIDENCE to a folder to also write the proposal screenshots there.
 */
const STORE_A = "0190f5a2-3b4c-7d8e-9f01-0000000000b1";
const STORE_B = "0190f5a2-3b4c-7d8e-9f01-0000000000b3";
const PROPOSAL = "0190f5a2-3b4c-7d8e-9f01-0000000000a1";
const LINE_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000d1";
const LINE_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000d2";
const PRODUCT_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000e1";
const PRODUCT_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000e2";
const TRANSFER = "0190f5a2-3b4c-7d8e-9f01-0000000000f1";
const USER = "0190f5a2-3b4c-7d8e-9f01-0000000000c1";
const NOW = "2026-11-26T08:00:00.000Z";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function ctx() {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: "owner",
    memberships: [
      {
        tenant_id: "t1",
        tenant_name: "Northstar Retail",
        role_code: "owner",
        store_access_kind: "all",
      },
    ],
  };
}

function lineOf(id: string, productId: string, quantity: string) {
  return {
    id,
    productId,
    sourceStoreId: STORE_A,
    destinationStoreId: STORE_B,
    quantity,
    stockingUnit: "piece",
    warnings: [],
    reviewDecision: null as unknown,
    acceptOutcome: null as unknown,
  };
}

interface Backend {
  proposal: Record<string, unknown> & { lines: ReturnType<typeof lineOf>[]; state: string };
  computed: boolean;
  calls: { method: string; path: string; body: unknown; key?: string }[];
}

function freshProposal(): Backend["proposal"] {
  return {
    id: PROPOSAL,
    state: "open",
    acceptEnabled: true,
    createdAt: NOW,
    createdBy: USER,
    expiresAt: "2026-11-27T08:00:00.000Z",
    decidedAt: null,
    supersededBy: null,
    rejectReason: null,
    rule: { name: "reorder_gap_greedy", version: "1.0.0" },
    computedAt: NOW,
    limits: { maxStores: 50, maxRows: 20000, deadlineMs: 5000, maxLinesPerTransfer: 100 },
    buffer: { minimum: "1.0000", percentOfReorderLevel: 10, rounding: "scale" },
    stores: [
      { storeId: STORE_A, readAt: NOW, eligibleAsSource: true, exclusion: null },
      {
        storeId: STORE_B,
        readAt: NOW,
        eligibleAsSource: false,
        exclusion: "device_heartbeat_stale",
      },
    ],
    objective: { deficitBefore: "20.0000", deficitAfter: "4.0000", storePairs: 1, lines: 2 },
    validator: { passed: true, violations: [] },
    warnings: [],
    lines: [lineOf(LINE_1, PRODUCT_1, "8.0000"), lineOf(LINE_2, PRODUCT_2, "2.5000")],
  };
}

function summaryOf(p: Backend["proposal"]) {
  return {
    id: p.id,
    state: p.state,
    acceptEnabled: true,
    createdAt: NOW,
    expiresAt: p.expiresAt,
    computedAt: NOW,
    objective: p.objective,
    lineCount: p.lines.length,
    excludedStoreCount: 1,
    warningCount: 0,
  };
}

const decided = { decidedAt: NOW, decidedBy: USER };

/** Plays the RT-1600 runtime over the stateful mock. */
function answer(b: Backend, method: string, path: string, body: Record<string, unknown>) {
  const tail = path.split("/").pop();
  if (method === "POST" && tail === "redistribution-proposals") {
    b.computed = true;
    b.proposal = freshProposal();
    return json(b.proposal, 201);
  }
  if (method === "GET" && tail === "redistribution-proposals") {
    return json({ items: b.computed ? [summaryOf(b.proposal)] : [], nextCursor: null });
  }
  if (tail === "review") {
    const decisions = body.lineDecisions as { lineId: string; decision: string }[];
    for (const d of decisions) {
      const l = b.proposal.lines.find((x) => x.id === d.lineId);
      if (l) l.reviewDecision = { decision: d.decision, note: null, ...decided };
    }
    b.proposal.state = "reviewed";
    return json(b.proposal);
  }
  if (tail === "accept") {
    const created = {
      outcome: "created",
      proposedQuantity: "8.0000",
      createdQuantity: "8.0000",
      transferId: TRANSFER,
      reason: null,
      ...decided,
    };
    const dropped = {
      outcome: "dropped",
      proposedQuantity: "2.5000",
      createdQuantity: null,
      transferId: null,
      reason: "source_available_insufficient",
      ...decided,
    };
    b.proposal.lines[0].acceptOutcome = created;
    b.proposal.lines[1].acceptOutcome = dropped;
    b.proposal.state = "accepted";
    return json({
      lines: [
        { lineId: LINE_1, outcome: created },
        { lineId: LINE_2, outcome: dropped },
      ],
      transferIds: [TRANSFER],
      proposal: b.proposal,
    });
  }
  if (method === "GET" && b.computed) return json(b.proposal);
  return json({ error: { code: "not_found", message: "Not Found" } }, 404);
}

async function mockBackend(page: Page): Promise<Backend> {
  const b: Backend = { proposal: freshProposal(), computed: false, calls: [] };
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx())));
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill(
      json([
        { id: STORE_A, code: "MAA", name: "Maadi" },
        { id: STORE_B, code: "ZAM", name: "Zamalek" },
      ]),
    ),
  );
  await page.route("**/api/v1/catalog/products/**", (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    const name = id === PRODUCT_1 ? "Mineral water 1.5L" : "Orange juice 1L";
    return r.fulfill(json({ summary: { productId: id, name } }));
  });
  await page.route("**/api/inventory/v1/redistribution-proposals**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    let body: Record<string, unknown> = {};
    if (req.method() !== "GET") {
      try {
        body = req.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      b.calls.push({ method: req.method(), path, body, key: req.headers()["idempotency-key"] });
    }
    return r.fulfill(answer(b, req.method(), path, body));
  });
  return b;
}

async function evidence(page: Page, name: string, appLocale: string): Promise<void> {
  const dir = process.env.REDISTRIBUTION_EVIDENCE;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${appLocale}.png`, fullPage: true });
}

test("J1: compute → review → accept to a draft transfer", async ({ page, t, appLocale }) => {
  const b = await mockBackend(page);
  await page.goto("/inventory/redistribution");
  await expect(page.getByText(t("redistribution.list.empty"))).toBeVisible();

  // 1. Compute: the new proposal opens.
  await page.getByRole("button", { name: t("redistribution.compute.action") }).click();
  await expect(page.getByRole("heading", { name: t("redistribution.detail.title") })).toBeVisible();
  await expect(page.getByText(t("redistribution.phase.live"))).toBeVisible();
  await expect(page.getByText(t("redistribution.exclusion.device_heartbeat_stale"))).toBeVisible();
  await expect(page.getByText("Mineral water 1.5L")).toBeVisible();
  await expectNoAxeViolations(page, "redistribution proposal");
  await evidence(page, "redistribution-proposal", appLocale);

  // 2. Review: "would accept" on the first line; nothing is created.
  const review = page.getByRole("group", {
    name: t("redistribution.lines.rowLabel", { product: "Mineral water 1.5L" }),
  });
  await review.getByRole("button", { name: t("redistribution.review.wouldAccept") }).click();
  await expect(
    review.getByRole("button", { name: t("redistribution.review.wouldAccept") }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(t("redistribution.state.reviewed"))).toBeVisible();

  // 3. Accept both lines: one becomes a draft transfer, the other is dropped with its reason.
  for (const product of ["Mineral water 1.5L", "Orange juice 1L"]) {
    await page
      .getByRole("checkbox", { name: t("redistribution.lines.select", { product }) })
      .check();
  }
  await page.getByRole("button", { name: t("redistribution.accept.open", { count: 2 }) }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(t("redistribution.accept.consequence", { count: 2 })),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: t("redistribution.accept.commit", { count: 2 }) })
    .click();
  await expect(
    dialog.getByText(
      t("redistribution.accept.resultCounts", { created: 1, reduced: 0, dropped: 1 }),
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: t("redistribution.dialog.done") }).click();
  await expect(
    page.getByText(t("redistribution.reason.source_available_insufficient")),
  ).toBeVisible();
  await expect(page.getByText(t("redistribution.state.accepted")).first()).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: t("redistribution.transfer.openLabel", { id: TRANSFER }) })
      .first(),
  ).toHaveAttribute("href", "/inventory/transfers");
  await evidence(page, "redistribution-accepted", appLocale);

  // The wire: one compute, one review, one accept, each with its own Idempotency-Key.
  const commands = b.calls.map((c) => c.path.split("/").pop());
  expect(commands).toEqual(["redistribution-proposals", "review", "accept"]);
  expect(new Set(b.calls.map((c) => c.key)).size).toBe(3);
  expect(b.calls[2]?.body).toEqual({ lineIds: [LINE_1, LINE_2] });
});

test("J2: feature off reads as not available, with no compute", async ({ page, t }) => {
  await mockBackend(page);
  await page.route("**/api/inventory/v1/redistribution-proposals**", (r) =>
    r.fulfill(json({ error: { code: "not_found", message: "Not Found" } }, 404)),
  );
  await page.goto("/inventory/redistribution");
  await expect(page.getByText(t("redistribution.notAvailable"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("redistribution.compute.action") })).toHaveCount(
    0,
  );
});
