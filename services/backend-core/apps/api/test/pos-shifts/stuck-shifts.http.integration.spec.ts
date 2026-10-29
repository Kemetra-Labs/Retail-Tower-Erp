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
  expectSchema,
  getStuck,
  minutesAgo,
  openOn,
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
