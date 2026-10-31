import { ShiftTimeBar } from "@/shift-closes/ShiftTimeBar";
import { shiftTimeFacts, splitMinutes } from "@/shift-closes/shiftTimes";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CLOSED_AT, OPENED_AT, RECEIVED_AT, detail } from "./shift-close-fixtures";

/**
 * RT-1015: the shift time bar. The model places the three served instants and
 * derives whole minutes; the component draws them with a text equivalent and
 * renders nothing without an `openedAt`. Cash figures are never involved.
 */

afterEach(cleanup);

describe("shiftTimeFacts", () => {
  test("places open, close and the server's recording on one axis, with whole-minute duration", () => {
    const facts = shiftTimeFacts({
      openedAt: OPENED_AT,
      closedAt: CLOSED_AT,
      receivedAt: RECEIVED_AT,
    });
    expect(facts?.durationMinutes).toBe(12 * 60 + 25);
    const bar = facts?.bar;
    expect(bar).toBeTruthy();
    if (!bar) return;
    expect(bar.startPct).toBeGreaterThan(0);
    expect(bar.startPct).toBeLessThan(bar.endPct);
    expect(bar.endPct).toBeLessThanOrEqual(bar.receivedPct);
    expect(bar.receivedPct).toBeLessThan(100);
  });

  test("no readable openedAt means no model at all (AC 3)", () => {
    expect(shiftTimeFacts({ closedAt: CLOSED_AT, receivedAt: RECEIVED_AT })).toBeNull();
    expect(shiftTimeFacts({ openedAt: null, closedAt: CLOSED_AT })).toBeNull();
    expect(shiftTimeFacts({ openedAt: "not a time", closedAt: CLOSED_AT })).toBeNull();
    expect(shiftTimeFacts({ openedAt: OPENED_AT, closedAt: "not a time" })).toBeNull();
  });

  test("a close before the open (POS clock) draws no bar and states no duration", () => {
    expect(shiftTimeFacts({ openedAt: CLOSED_AT, closedAt: OPENED_AT })).toEqual({
      bar: null,
      durationMinutes: null,
    });
  });

  test("a zero-length shift draws no bar and no duration", () => {
    expect(shiftTimeFacts({ openedAt: OPENED_AT, closedAt: OPENED_AT })).toEqual({
      bar: null,
      durationMinutes: null,
    });
  });

  test("a recording time that is not readable falls back to the close", () => {
    const facts = shiftTimeFacts({
      openedAt: OPENED_AT,
      closedAt: CLOSED_AT,
      receivedAt: "nope",
    });
    expect(facts?.bar?.receivedPct).toBe(facts?.bar?.endPct);
  });

  test("splits whole minutes into hours and the rest", () => {
    expect(splitMinutes(545)).toEqual({ hours: 9, minutes: 5 });
    expect(splitMinutes(60)).toEqual({ hours: 1, minutes: 0 });
    expect(splitMinutes(7)).toEqual({ hours: 0, minutes: 7 });
  });
});

describe("ShiftTimeBar", () => {
  test("the bar is named in one sentence and every time is also written out", () => {
    render(<ShiftTimeBar detail={detail()} timeZone="Asia/Dubai" />);
    const bar = screen.getByRole("img");
    // 08:05Z → 12:05 in Dubai (+4), closed 20:30Z → 00:30 next day, recorded 00:31.
    expect(bar.getAttribute("aria-label")).toBe(
      "Opened Oct 7, 2026, 12:05, closed Oct 8, 2026, 00:30, recorded on the server Oct 8, 2026, 00:31",
    );
    const facts = document.querySelector(".shift-timebar__facts") as HTMLElement;
    expect(within(facts).getByText("Opened at")).toBeDefined();
    expect(within(facts).getByText("Oct 7, 2026, 12:05")).toBeDefined();
    expect(within(facts).getByText("Closed at")).toBeDefined();
    expect(within(facts).getByText("Oct 8, 2026, 00:30")).toBeDefined();
    expect(within(facts).getByText("Recorded by the server at")).toBeDefined();
    expect(within(facts).getByText("Oct 8, 2026, 00:31")).toBeDefined();
    expect(within(facts).getByText("Shift duration")).toBeDefined();
    expect(within(facts).getByText("12 hours and 25 minutes")).toBeDefined();
  });

  test("an unknown zone reads in UTC, labelled", () => {
    render(<ShiftTimeBar detail={detail()} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Oct 7, 2026, 08:05 UTC");
  });

  test("renders nothing without an openedAt", () => {
    const { container } = render(
      <ShiftTimeBar detail={{ ...detail(), openedAt: undefined as unknown as string }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("a close before the open keeps the times as text and drops the bar", () => {
    render(<ShiftTimeBar detail={detail({ openedAt: CLOSED_AT, closedAt: OPENED_AT })} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Shift duration")).toBeNull();
    expect(screen.getByText("Opened at")).toBeDefined();
  });

  test("an hour-only duration drops the empty minutes", () => {
    render(
      <ShiftTimeBar
        detail={detail({ openedAt: "2026-10-07T08:00:00Z", closedAt: "2026-10-07T11:00:00Z" })}
      />,
    );
    expect(screen.getByText("3 hours")).toBeDefined();
  });
});
