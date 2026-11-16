/**
 * GET /api/pos/v1/shifts/stuck over HTTP — RT-811 (`pos-shifts.openapi.yaml`
 * 1.5.0-draft; owner decision RT-811 comment 14372), against real Postgres
 * with every migration (the RT-17 shift harness).
 *
 * Proves the stuck-list predicate in the database: an open shift older than
 * the threshold is listed; a younger one, one whose opening cashier holds a
 * live `pos_operator` session on the store, and (RT-811) one whose opening
 * terminal holds a live cashier admission of any user are not; an expired
 * admission, one ended by the device or by a takeover, and one on another
 * terminal of the store do not hide the shift.
 */
import {
  CASHIER,
  CASHIER_UNADMITTED,
  DEV_A1,
  DEV_A1_SECOND,
  MANAGER,
  STORE_A1,
  admin,
  expectSchema,
  forcedClosePath,
  getStuck,
  managerEnvelope,
  minutesAgo,
  newKey,
  openOn,
  post,
  resetState,
  seedAdmission,
  seedLegacyShift,
  seedLiveAdmission,
  seedOperatorSession,
  skipped,
  startHarness,
  stopHarness,
} from "./__support__/shift-http-harness";

beforeAll(() => startHarness("stuck-shifts.http"), 240_000);
afterAll(() => stopHarness(), 60_000);
afterEach(() => resetState());

/** The `shift_id`s `GET /shifts/stuck` lists for store A1 (asserts 200 and the contract schema). */
async function listedOnA1(): Promise<string[]> {
  const res = await getStuck(STORE_A1);
  expect(res.status).toBe(200);
  expectSchema("StuckShiftsResponse", res.body);
  return (res.body.shifts as Array<{ shift_id: string }>).map((s) => s.shift_id);
}

describe("GET /shifts/stuck — the stuck-list predicate in the database", () => {
  it("lists an open shift older than the threshold, with its cashier and terminal", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await getStuck(STORE_A1);
    expect(res.status).toBe(200);
    expect(res.body.shifts).toEqual([
      expect.objectContaining({ shift_id: shiftId, cashier_display_name: "cashier", terminal_label: "till-0001" }),
    ]);
  });

  it("does not list a shift younger than the threshold", async () => {
    if (skipped()) return;
    await openOn(DEV_A1, { openedAt: minutesAgo(5) });
    expect(await listedOnA1()).toEqual([]);
  });

  it("does not list a shift whose opening cashier holds a live pos_operator session on the store", async () => {
    if (skipped()) return;
    await seedLegacyShift(DEV_A1, { user: MANAGER.id });
    await seedOperatorSession(MANAGER, DEV_A1_SECOND);
    expect(await listedOnA1()).toEqual([]);
  });
});

describe("GET /shifts/stuck — RT-811 a live cashier admission on the opening terminal", () => {
  it("does not list a shift while its cashier's admission on the opening terminal is live", async () => {
    if (skipped()) return;
    await openOn(DEV_A1);
    await seedLiveAdmission(CASHIER, DEV_A1);
    expect(await listedOnA1()).toEqual([]);
  });

  it("any user's live admission on the opening terminal hides it", async () => {
    if (skipped()) return;
    await openOn(DEV_A1);
    await seedLiveAdmission(CASHIER_UNADMITTED, DEV_A1);
    expect(await listedOnA1()).toEqual([]);
  });

  it("hides a stuck legacy shift too", async () => {
    if (skipped()) return;
    await seedLegacyShift(DEV_A1);
    await seedLiveAdmission(CASHIER, DEV_A1);
    expect(await listedOnA1()).toEqual([]);
  });

  it.each(["expired", "device_end", "takeover"] as const)(
    "an admission that is %s does not hide it",
    async (state) => {
      if (skipped()) return;
      const shiftId = await openOn(DEV_A1);
      await seedAdmission(CASHIER, DEV_A1, state);
      expect(await listedOnA1()).toEqual([shiftId]);
    },
  );

  it("a live admission on another terminal of the store does not hide it", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    await seedLiveAdmission(CASHIER, DEV_A1_SECOND);
    expect(await listedOnA1()).toEqual([shiftId]);
  });
});

describe("GET /shifts/stuck — RT-1438 an opener with no display name is still listed", () => {
  const FALLBACK = "cashier@rt17-s2b.example";

  /** Runs `fn` with CASHIER's display_name set to `value`, restoring it after. */
  async function withDisplayName<T>(value: string | null, fn: () => Promise<T>): Promise<T> {
    await admin().query(`UPDATE users SET display_name = $2 WHERE id = $1`, [CASHIER.id, value]);
    try {
      return await fn();
    } finally {
      await admin().query(`UPDATE users SET display_name = 'cashier' WHERE id = $1`, [CASHIER.id]);
    }
  }

  /** Force close of `shiftId` by the manager from another terminal of the store. */
  async function forceCloseStatus(shiftId: string): Promise<number> {
    const res = await post({
      path: forcedClosePath(shiftId),
      bearer: await managerEnvelope(DEV_A1_SECOND),
      body: { forcedReason: "RT-1438 eligibility agreement" },
      key: newKey(),
    });
    return res.status;
  }

  it.each([
    ["NULL", null],
    ["empty", ""],
    ["blank", "   "],
  ] as const)("lists a stuck shift whose opener's display_name is %s, under the email", async (_label, value) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    await withDisplayName(value, async () => {
      const res = await getStuck(STORE_A1);
      expect(res.status).toBe(200);
      expectSchema("StuckShiftsResponse", res.body);
      expect(res.body.shifts).toEqual([
        expect.objectContaining({ shift_id: shiftId, cashier_display_name: FALLBACK, terminal_label: "till-0001" }),
      ]);
    });
  });

  it("a real display name is still shown, not the email", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    await withDisplayName("Jane Smith", async () => {
      const res = await getStuck(STORE_A1);
      expect(res.body.shifts).toEqual([expect.objectContaining({ shift_id: shiftId, cashier_display_name: "Jane Smith" })]);
    });
  });

  it.each([
    ["stuck", async () => openOn(DEV_A1), true],
    ["stuck legacy", async () => seedLegacyShift(DEV_A1), true],
    ["younger than the threshold", async () => openOn(DEV_A1, { openedAt: minutesAgo(5) }), false],
    [
      "a live admission on the opening terminal",
      async () => {
        const id = await openOn(DEV_A1);
        await seedLiveAdmission(CASHIER_UNADMITTED, DEV_A1);
        return id;
      },
      false,
    ],
    [
      "a live session of the opener on the store",
      async () => {
        const id = await openOn(DEV_A1);
        await seedOperatorSession(CASHIER, DEV_A1_SECOND);
        return id;
      },
      false,
    ],
  ] as const)(
    "a NULL-name opener's %s shift: the list and the force close agree (eligible = %s)",
    async (_label, seed, eligible) => {
      if (skipped()) return;
      await withDisplayName(null, async () => {
        const shiftId = await seed();
        const listed = (await listedOnA1()).includes(shiftId);
        const forceClosed = (await forceCloseStatus(shiftId)) === 201;
        expect({ listed, forceClosed }).toEqual({ listed: eligible, forceClosed: eligible });
      });
    },
  );
});
