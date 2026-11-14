import { useState, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangProvider } from "../../i18n/LangContext";
import { format, type Lang } from "../../i18n/strings";
import { buildBoard } from "../../model/board";
import type { Board } from "../../model/types";
import type { PortBridge } from "../../bridge/usePortBridge";
import { NOW, createFakePort, fixture } from "../../state/__tests__/testkit";
import { isDemo } from "../../state/demo";
import { ModeSwitch } from "../ModeSwitch";
import { Tour, tourSteps } from "../Tour";

const bridge = vi.hoisted(() => ({ value: undefined as unknown as PortBridge }));
vi.mock("../../bridge/usePortBridge", () => ({ usePortBridge: () => bridge.value }));

import { App } from "../../App";

const boardOf = (opts: { faultsOnC4?: number; sentryRead?: boolean } = {}): Board => {
  const board = buildBoard(fixture(), { now: NOW, demo: false, alarmRead: { sentry: opts.sentryRead ?? true } });
  if (opts.faultsOnC4 !== undefined) {
    board.cables = board.cables.map((c) => (c.id === "c4" ? { ...c, faults: opts.faultsOnC4 as number } : c));
  }
  return board;
};

type Format = typeof format;
const tIn = (lang: Lang) => (key: Parameters<Format>[0], vars?: Parameters<Format>[2]) => format(key, lang, vars);
const step5 = (board: Board, lang: Lang): string => tourSteps(board, tIn(lang))[4].text;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("tour text", () => {
  it("reads the fault count of step 5 from the invoice cable of the board (3 on the fixture, not 4)", () => {
    expect(step5(boardOf(), "en")).toContain("3 faults on the invoice cable");
    expect(step5(boardOf(), "ar")).toContain("3 أعطال على كابل الفواتير");
    expect(step5(boardOf(), "en")).not.toContain("4 faults");
  });

  it("phrases 1, 2 and 11 faults correctly in both languages", () => {
    expect(step5(boardOf({ faultsOnC4: 1 }), "en")).toContain("1 fault on the invoice cable");
    expect(step5(boardOf({ faultsOnC4: 1 }), "en")).not.toContain("1 faults");
    expect(step5(boardOf({ faultsOnC4: 1 }), "ar")).toContain("عطل واحد على كابل الفواتير");
    expect(step5(boardOf({ faultsOnC4: 2 }), "ar")).toContain("عطلين على كابل الفواتير");
    expect(step5(boardOf({ faultsOnC4: 11 }), "en")).toContain("11 faults on the invoice cable");
    expect(step5(boardOf({ faultsOnC4: 11 }), "ar")).toContain("11 عطل على كابل الفواتير");
  });

  it("says no faults are reported (and never that anything is healthy) when the cable has none", () => {
    const en = step5(boardOf({ faultsOnC4: 0 }), "en");
    expect(en).toContain("No faults are reported on the invoice cable");
    expect(en).not.toMatch(/\d+ faults?/);
    expect(en.replace("never as healthy", "")).not.toMatch(/healthy/);
    expect(step5(boardOf({ faultsOnC4: 0 }), "ar")).toContain("مفيش أعطال مبلّغ عنها على كابل الفواتير");
  });

  it("says fault counts are not read when the error read failed, and claims no health", () => {
    const board = boardOf({ sentryRead: false });
    const en = step5(board, "en");
    expect(en).toContain("fault counts are not read");
    expect(en).not.toMatch(/\d+ faults? on the invoice cable/);
    expect(en).not.toContain("No faults");
    expect(en.replace("never as healthy", "")).not.toMatch(/healthy/);
    expect(step5(board, "ar")).toContain("عدد الأعطال مش مقروء");
  });

  it("has five steps with a title and text in both languages", () => {
    for (const lang of ["en", "ar"] as const) {
      const steps = tourSteps(boardOf(), tIn(lang));
      expect(steps).toHaveLength(5);
      for (const s of steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.text.length).toBeGreaterThan(0);
      }
    }
    expect(tourSteps(boardOf(), tIn("en"))[0].title).toBe("One test lab, from till to ledger");
    expect(tourSteps(boardOf(), tIn("ar"))[0].title).toBe("معمل تجربة واحد، من الكاشير للدفتر");
  });

  it("frames only stations and cables that exist, and the last step frames the invoice cable", () => {
    const last = tourSteps(boardOf(), tIn("en"))[4];
    expect(last.cables).toEqual(["c4"]);
    expect(last.stations).toEqual(["conn", "erp"]);
    expect(tourSteps(boardOf(), tIn("en"))[0]).toMatchObject({ stations: null, cables: null });
  });
});

describe("Tour", () => {
  function Harness({ onEnd = () => {}, lang = "en" }: { onEnd?: () => void; lang?: Lang }) {
    const [index, setIndex] = useState(0);
    return (
      <LangProvider initial={lang}>
        <Tour steps={tourSteps(boardOf(), tIn(lang))} index={index} onIndex={setIndex} onEnd={onEnd} />
      </LangProvider>
    );
  }

  it("moves focus to Next on start, steps with Next and Back, and stops at the ends", () => {
    rtlRender(<Harness />);
    const next = screen.getByRole("button", { name: "Next" });
    expect(document.activeElement).toBe(next);
    expect(screen.getByText("Step 1 of 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" }).getAttribute("aria-disabled")).toBe("true");
    for (let i = 2; i <= 5; i++) {
      fireEvent.click(next);
      expect(screen.getByText(`Step ${i} of 5`)).toBeTruthy();
    }
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(next);
    expect(screen.getByText("Step 5 of 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 4 of 5")).toBeTruthy();
  });

  it("never advances on a timer: it stays on a step for 10 minutes", () => {
    vi.useFakeTimers();
    rtlRender(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    act(() => void vi.advanceTimersByTime(10 * 60 * 1000));
    expect(screen.getByText("Step 2 of 5")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends from the Exit button and on Escape", () => {
    const onEnd = vi.fn();
    rtlRender(<Harness onEnd={onEnd} />);
    fireEvent.click(screen.getByRole("button", { name: "Exit tour" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("leaves Escape to an open detail", () => {
    const onEnd = vi.fn();
    rtlRender(<Harness onEnd={onEnd} />);
    const detail = document.createElement("div");
    detail.setAttribute("data-detail", "");
    document.body.appendChild(detail);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEnd).not.toHaveBeenCalled();
    detail.remove();
  });

  it("reads in Arabic", () => {
    rtlRender(<Harness lang="ar" />);
    expect(screen.getByText("خطوة 1 من 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "التالي" })).toBeTruthy();
  });
});

describe("ModeSwitch", () => {
  const setup = (mode: "ops" | "story") => {
    const onMode = vi.fn();
    const onTour = vi.fn();
    rtlRender(
      <LangProvider>
        <ModeSwitch mode={mode} onMode={onMode} tourOn={false} onTour={onTour} />
      </LangProvider>,
    );
    return { onMode, onTour };
  };

  it("marks the current mode as pressed and asks for the other one", () => {
    const { onMode } = setup("ops");
    expect(screen.getByRole("button", { name: "Ops" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Story" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    expect(onMode).toHaveBeenCalledWith("story");
  });

  it("shows the Tour button in Story mode only", () => {
    setup("ops");
    expect(screen.queryByRole("button", { name: "Story tour" })).toBeNull();
    cleanup();
    const { onTour } = setup("story");
    fireEvent.click(screen.getByRole("button", { name: "Story tour" }));
    expect(onTour).toHaveBeenCalled();
  });
});

describe("isDemo", () => {
  it("is true only when the URL has demo=1", () => {
    expect(isDemo()).toBe(false);
    window.history.pushState({}, "", "/?demo=0");
    expect(isDemo()).toBe(false);
    window.history.pushState({}, "", "/?demo=true");
    expect(isDemo()).toBe(false);
    window.history.pushState({}, "", "/?a=1&demo=1");
    expect(isDemo()).toBe(true);
  });
});

function setBridge(): void {
  bridge.value = {
    token: "tok-secret",
    baseUrl: "https://api.getport.io",
    applyThemeCss: () => {},
    trusted: true,
    status: "ready",
  };
}
function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}
const dimmed = (container: HTMLElement, selector: string, attr: string): string[] =>
  Array.from(container.querySelectorAll(selector))
    .map((n) => n.getAttribute(attr) ?? "")
    .sort();
const dimmedStations = (c: HTMLElement) => dimmed(c, ".station.dim", "data-focus");
const dimmedCables = (c: HTMLElement) => dimmed(c, "path.cable.dim[data-cable]", "data-cable");

describe("App modes", () => {
  beforeEach(() => {
    cleanup();
    createFakePort().install();
    setBridge();
  });

  const loaded = async () => {
    const view = render(<App />);
    await screen.findByText(/3 faults on the invoice cable/, {}, { timeout: 4000 });
    return view;
  };

  it("Ops is the default: readings, the lower panels, no Tour button, no example button", async () => {
    const { container } = await loaded();
    expect(screen.getByRole("button", { name: "Ops" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("[data-lower-panels] > section")).toHaveLength(4);
    expect(container.querySelectorAll(".station .sv").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Story tour" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Example/ })).toBeNull();
  });

  it("Story hides readings, the table and the lower panels, keeps pins, the verdict and the alarm panel", async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    expect(container.querySelector("[data-lower-panels]")).toBeNull();
    expect(container.querySelectorAll(".station .sv")).toHaveLength(0);
    expect(container.querySelector(".table-toggle")).toBeNull();
    expect(container.querySelectorAll(".pin")).toHaveLength(5);
    expect(container.querySelectorAll('[data-focus^="station:"]')).toHaveLength(5);
    expect(container.querySelector(".srole")).toBeTruthy();
    expect(screen.getByText(/3 faults on the invoice cable/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Alarms (5)" })).toBeTruthy();
    expect(container.querySelector(".shell")?.className).toContain("mode-story");
    expect(screen.getByRole("button", { name: "Story tour" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ops" }));
    expect(container.querySelectorAll("[data-lower-panels] > section")).toHaveLength(4);
    expect(container.querySelectorAll(".station .sv").length).toBeGreaterThan(0);
  });

  it("starts the tour with focus on Next, dims what is outside the frame, and reads the count from the board", async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Story tour" }));
    const next = screen.getByRole("button", { name: "Next" });
    expect(document.activeElement).toBe(next);
    expect(dimmedStations(container)).toEqual([]);
    expect(dimmedCables(container)).toEqual([]);
    fireEvent.click(next);
    expect(dimmedStations(container)).toEqual(["station:conn", "station:core", "station:erp"]);
    expect(dimmedCables(container)).toEqual(["c3", "c4"]);
    for (let i = 0; i < 3; i++) fireEvent.click(next);
    expect(screen.getByText("Step 5 of 5")).toBeTruthy();
    const card = screen.getByRole("region", { name: "Story tour" });
    expect(card.textContent).toContain("3 faults on the invoice cable");
    expect(card.textContent).not.toContain("4 faults");
    expect(dimmedStations(container)).toEqual(["station:admin", "station:core", "station:pos"]);
    expect(dimmedCables(container)).toEqual(["c1", "c2", "c3"]);
  });

  it("Escape ends the tour, the dimming goes and focus returns to the Tour button", async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    const tourButton = screen.getByRole("button", { name: "Story tour" });
    fireEvent.click(tourButton);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Story tour" })).toBeNull();
    expect(dimmedStations(container)).toEqual([]);
    expect(document.activeElement).toBe(tourButton);
  });

  it("a mode switch while the tour is open ends the tour", async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Story tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Ops" }));
    expect(screen.queryByRole("region", { name: "Story tour" })).toBeNull();
    expect(dimmedStations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    expect(screen.queryByRole("region", { name: "Story tour" })).toBeNull();
  });

  it("switches language with the tour and a detail open without throwing", async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Story tour" }));
    fireEvent.click(container.querySelector('[data-focus="station:conn"]') as Element);
    expect(container.querySelector("[data-detail]")).toBeTruthy();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "عربي" }))).not.toThrow();
    expect(screen.getByRole("region", { name: "جولة القصة" })).toBeTruthy();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "English" }))).not.toThrow();
    expect(screen.getByRole("region", { name: "Story tour" })).toBeTruthy();
  });

  it("keeps the same hooks before and after the token arrives", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    bridge.value = { token: null, baseUrl: null, applyThemeCss: () => {}, trusted: false, status: "waiting" };
    const ui = (
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );
    const view = rtlRender(ui);
    setBridge();
    expect(() => view.rerender(ui)).not.toThrow();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hook/i);
    errors.mockRestore();
  });
});

describe("App example alarm", () => {
  beforeEach(() => {
    cleanup();
    createFakePort().install();
    setBridge();
  });

  it("has no example button without demo=1", async () => {
    render(<App />);
    await screen.findByText(/3 faults on the invoice cable/, {}, { timeout: 4000 });
    expect(screen.queryByRole("button", { name: /Example/ })).toBeNull();
  });

  it("with demo=1 the button adds a labelled example alarm, and hiding it with its detail open clears the selection", async () => {
    window.history.pushState({}, "", "/?demo=1");
    const { container } = render(<App />);
    await screen.findByText(/3 faults on the invoice cable/, {}, { timeout: 4000 });
    const toggle = screen.getByRole("button", { name: "Example: a Datadog alarm" });
    fireEvent.click(toggle);
    expect(screen.getByRole("tab", { name: "Alarms (6)" })).toBeTruthy();
    expect(screen.getAllByText("Example, not real").length).toBeGreaterThan(0);
    fireEvent.click(container.querySelector('[data-focus="alarm:example-latency"]') as Element);
    expect(container.querySelector("[data-detail]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the example" }));
    await waitFor(() => expect(container.querySelector("[data-detail]")).toBeNull());
    expect(screen.getByRole("tab", { name: "Alarms (5)" })).toBeTruthy();
    expect(container.querySelector('[aria-pressed="true"][data-focus^="alarm:"]')).toBeNull();
  });
});
