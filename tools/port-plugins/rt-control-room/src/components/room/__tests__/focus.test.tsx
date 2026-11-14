import { useEffect, useRef, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "../../../model/board";
import { LangProvider } from "../../../i18n/LangContext";
import { fixture, NOW } from "../../../state/__tests__/testkit";
import { ControlRoom } from "../ControlRoom";
import { useSelection } from "../useFocusReturn";
import type { Selection } from "../selection";

const board = buildBoard(fixture(), { now: NOW, demo: false });
const ALARM = "sentry-10001";
const OTHER = "sentry-10005";

const activeTab = () => document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

/** A stand-in for the alarm panel and the detail of the next task: tabs, an alarm list, a detail with Back. */
function Harness({ tab, mapKey = "a", children }: { tab: "alarms" | "events"; mapKey?: string; children?: ReactNode }) {
  const { selection, select } = useSelection({ fallback: activeTab });
  const heading = useRef<HTMLHeadingElement>(null);
  const byKey = useRef(false);
  const open = (sel: Selection, key?: boolean) => {
    byKey.current = !!key;
    select(sel, key);
  };
  useEffect(() => {
    if (selection && byKey.current) heading.current?.focus();
  }, [selection]);
  return (
    <LangProvider>
      <div data-testid="bg" onClick={() => select(null, false)}>
        <div role="tablist">
          <button type="button" role="tab" aria-selected={tab === "alarms"}>Alarms</button>
          <button type="button" role="tab" aria-selected={tab === "events"}>Events</button>
        </div>
        <ul hidden={tab !== "alarms"}>
          <li>
            <button type="button" data-focus={`alarm:${ALARM}`} onClick={(e) => {
                e.stopPropagation();
                open({ type: "alarm", id: ALARM }, false);
              }}>
              list alarm
            </button>
          </li>
        </ul>
        <div data-testid="plain" onClick={(e) => { e.stopPropagation(); open({ type: "alarm", id: ALARM }, false); }}>
          not focusable
        </div>
        <ControlRoom
          key={mapKey}
          board={board}
          events={[]}
          replayQueue={[]}
          paused
          replaying={false}
          onReplayDone={() => {}}
          onSelect={open}
          selection={selection}
        />
        {selection && (
          <div data-detail>
            <h3 tabIndex={-1} ref={heading}>Detail {selection.id}</h3>
            <button type="button" onClick={() => open(null, true)}>Back</button>
            <button type="button" onClick={(e) => { e.stopPropagation(); open({ type: "alarm", id: OTHER }, true); }}>
              open another alarm
            </button>
          </div>
        )}
        {children}
      </div>
    </LangProvider>
  );
}

const focusKey = () => document.activeElement?.closest("[data-focus]")?.getAttribute("data-focus") ?? null;
const pin = (id = ALARM) => document.querySelector(`[data-focus="pin:${id}"]`) as HTMLElement;

let restore: () => void;
beforeEach(() => {
  // jsdom has no layout: an element counts as visible unless it sits in a hidden subtree.
  const proto = Element.prototype as unknown as { getClientRects: () => unknown[] };
  const saved = proto.getClientRects;
  proto.getClientRects = function (this: Element) {
    return this.closest("[hidden]") ? [] : [{}];
  };
  restore = () => {
    proto.getClientRects = saved;
  };
});
afterEach(() => {
  cleanup();
  restore();
  vi.restoreAllMocks();
});

describe("keyboard and focus", () => {
  it("Enter on a pin opens the detail and moves focus to its heading; Escape returns to the pin", async () => {
    const user = userEvent.setup();
    render(<Harness tab="events" />);
    pin().focus();
    expect(document.activeElement).toBe(pin());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { level: 3, name: `Detail ${ALARM}` })).toBe(document.activeElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(document.activeElement).toBe(pin());
  });

  it("Enter on a station opens it, and Back returns focus to that station", async () => {
    const user = userEvent.setup();
    render(<Harness tab="alarms" />);
    const core = document.querySelector('[data-focus="station:core"]') as HTMLElement;
    core.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.tagName).toBe("H3");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(core);
  });

  it("returns to the re-rendered replacement of the opener, found by its stable key", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness tab="events" mapKey="a" />);
    const old = pin();
    old.focus();
    await user.keyboard("{Enter}");
    rerender(<Harness tab="events" mapKey="b" />);
    expect(old.isConnected).toBe(false);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(pin());
    expect(document.activeElement).not.toBe(old);
  });

  it("opened from the alarm list on the Alarms tab: Escape returns to the visible list button", async () => {
    const user = userEvent.setup();
    render(<Harness tab="alarms" />);
    const listButton = screen.getByRole("button", { name: "list alarm" });
    listButton.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(listButton);
  });

  it("opened from a list button that is now hidden (Events tab): returns to the pin with the same alarm id", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness tab="alarms" />);
    screen.getByRole("button", { name: "list alarm" }).focus();
    await user.keyboard("{Enter}");
    rerender(<Harness tab="events" />);
    await user.keyboard("{Escape}");
    expect(focusKey()).toBe(`pin:${ALARM}`);
  });

  it("with no visible opener and no pin, falls back to the active tab button, never the body", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness tab="alarms" />);
    screen.getByRole("button", { name: "list alarm" }).focus();
    await user.keyboard("{Enter}");
    // The alarm vanishes from the map while its detail is open (a resolved issue).
    const gone = buildBoard({ ...fixture(), sentryIssues: [] }, { now: NOW, demo: false });
    expect(gone.alarms).toHaveLength(0);
    rerender(<Harness tab="events" mapKey="b" />);
    pin()?.remove();
    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.textContent).toBe("Events");
  });

  it("opening an alarm from inside a station detail keeps the first opener", async () => {
    const user = userEvent.setup();
    render(<Harness tab="events" />);
    const core = document.querySelector('[data-focus="station:core"]') as HTMLElement;
    core.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "open another alarm" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain(OTHER);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(core);
  });

  it("a mouse click on something that cannot take focus clears the stored opener (no stale restoration)", async () => {
    const user = userEvent.setup();
    render(<Harness tab="events" />);
    pin().focus();
    await user.keyboard("{Enter}");
    // Closed by the mouse: no focus return, and the old opener stays stored.
    await user.click(screen.getByTestId("bg"));
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    // Opened again by a click on a non-focusable target: body is active, so the stored key is cleared.
    await user.click(screen.getByTestId("plain"));
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(pin());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
  });

  it("Escape with nothing open does nothing", async () => {
    const user = userEvent.setup();
    render(<Harness tab="events" />);
    pin().focus();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(pin());
  });
});
