import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "../../model/board";
import { traceStats } from "../../model/telemetry";
import type { Board, TraceView } from "../../model/types";
import { fixture, NOW } from "../../state/__tests__/testkit";
import { LangProvider, useLang } from "../../i18n/LangContext";
import { STRINGS, agoText, fmtTime, type StringKey } from "../../i18n/strings";
import { Header } from "../Header";
import { Telemetry } from "../Telemetry";
import { Trace } from "../Trace";
import { Verdict } from "../Verdict";

const ARABIC_INDIC = /[٠-٩۰-۹]/;
const ARABIC = /[؀-ۿ]/;
const HOUR = 3_600_000;

const boardOf = (over: Parameters<typeof buildBoard>[1]["alarmRead"] | null = null, mutate?: (s: ReturnType<typeof fixture>) => void) => {
  const snap = fixture();
  mutate?.(snap);
  return buildBoard(snap, { now: NOW, demo: false, ...(over ? { alarmRead: over } : {}) });
};

function wrap(ui: ReactNode) {
  return render(<LangProvider>{ui}</LangProvider>);
}

type HeaderOver = Partial<Parameters<typeof Header>[0]>;
function headerProps(board: Board | null, over: HeaderOver = {}): Parameters<typeof Header>[0] {
  return {
    board,
    status: "ready",
    replaying: false,
    asOf: NOW,
    labUpdatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    paused: false,
    onTogglePause: () => {},
    ...over,
  };
}

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});
afterEach(cleanup);

describe("i18n table", () => {
  const keys = Object.keys(STRINGS) as StringKey[];

  it("has both languages for every key and no empty Arabic string", () => {
    expect(keys.length).toBeGreaterThan(60);
    for (const k of keys) {
      expect(STRINGS[k].en.trim(), `${k} en`).not.toBe("");
      expect(STRINGS[k].ar.trim(), `${k} ar`).not.toBe("");
    }
  });

  it("uses the same {placeholders} in both languages", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    // Arabic one and two ("ساعة", "ساعتين") are words without a number.
    const wordForms = (k: string) => /^ago\w+(One|Two)$/.test(k);
    for (const k of keys.filter((k) => !wordForms(k))) expect(holes(STRINGS[k].ar), k).toBe(holes(STRINGS[k].en));
  });

  it("never writes Arabic-Indic digits", () => {
    for (const k of keys) expect(STRINGS[k].ar, k).not.toMatch(ARABIC_INDIC);
  });
});

describe("clock and numbers", () => {
  it("formats a 24-hour Cairo clock with Latin digits in both languages", () => {
    // 2026-11-13 is winter time in Cairo (UTC+2).
    expect(fmtTime(new Date("2026-11-13T12:30:00Z"), "en")).toBe("14:30");
    expect(fmtTime(new Date("2026-11-13T12:30:00Z"), "ar")).toBe("14:30");
    expect(fmtTime(new Date("2026-11-13T22:07:00Z"), "ar")).toBe("00:07");
    expect(fmtTime(new Date("2026-11-13T21:05:00Z"), "en")).toBe("23:05");
  });

  it("never contains Arabic-Indic digits, whatever the instant", () => {
    for (let h = 0; h < 24; h += 1) {
      const d = new Date(Date.UTC(2026, 10, 13, h, 59));
      expect(fmtTime(d, "ar")).not.toMatch(ARABIC_INDIC);
      expect(fmtTime(d, "ar")).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("says how long ago, with Arabic plural forms and Latin digits", () => {
    expect(agoText(5 * 60_000, "en")).toBe("5 min ago");
    expect(agoText(HOUR, "en")).toBe("1 h ago");
    expect(agoText(HOUR, "ar")).toBe("من ساعة");
    expect(agoText(7 * HOUR, "ar")).toBe("من 7 ساعات");
    expect(agoText(18 * HOUR, "ar")).toBe("من 18 ساعة");
    expect(agoText(5 * 60_000, "ar")).toBe("من 5 دقايق");
    expect(agoText(2 * HOUR, "ar")).toBe("من ساعتين");
    expect(agoText(-5_000, "en")).toBe(STRINGS.agoNow.en);
    expect(agoText(3 * 86_400_000, "en")).toBe("3 d ago");
  });
});

describe("LangProvider", () => {
  function Probe() {
    const { lang, t, setLang } = useLang();
    return (
      <button type="button" onClick={() => setLang(lang === "en" ? "ar" : "en")}>
        {t("scope")}
      </button>
    );
  }

  it("sets lang and dir on <html> when the language changes", () => {
    wrap(<Probe />);
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("button").textContent).toBe(STRINGS.scope.ar);
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("fills {n} placeholders and keeps Latin digits", () => {
    function Count() {
      const { t } = useLang();
      return <p>{t("jiraSub", { n: 551 })}</p>;
    }
    const { container } = wrap(<Count />);
    expect(container.textContent).toBe("551 RT tasks by status.");
  });
});

describe("Header", () => {
  const board = boardOf();

  it("shows the wordmark, the sync time, the scope, the alarm count and the lab update age", () => {
    wrap(<Header {...headerProps(board)} />);
    expect(screen.getByText("Retail Tower")).toBeTruthy();
    expect(screen.getByText("As of last sync, 14:30")).toBeTruthy();
    expect(screen.getByText("Test lab, not real stores")).toBeTruthy();
    expect(screen.getByText("5 active alarms")).toBeTruthy();
    expect(screen.getByText("Lab updated 1 h ago")).toBeTruthy();
  });

  it("shows no replay chip unless replaying", () => {
    const { rerender } = wrap(<Header {...headerProps(board)} />);
    expect(screen.queryByText("Replaying recent changes (partial)")).toBeNull();
    rerender(
      <LangProvider>
        <Header {...headerProps(board, { replaying: true })} />
      </LangProvider>,
    );
    expect(screen.getByText("Replaying recent changes (partial)")).toBeTruthy();
  });

  it("hides the replay chip while paused (the replay stops)", () => {
    wrap(<Header {...headerProps(board, { replaying: true, paused: true })} />);
    expect(screen.queryByText("Replaying recent changes (partial)")).toBeNull();
  });

  it("switches to Arabic, rtl, with Latin digits and a 24-hour clock", () => {
    wrap(<Header {...headerProps(board)} />);
    fireEvent.click(screen.getByRole("button", { name: "عربي" }));
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText(STRINGS.scope.ar)).toBeTruthy();
    const asof = screen.getByText(/^حسب آخر مزامنة/);
    expect(asof.textContent).toBe("حسب آخر مزامنة، 14:30");
    expect(screen.getByText("المعمل اتحدث من ساعة")).toBeTruthy();
    expect(screen.getByText("5 إنذارات شغالة")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(ARABIC_INDIC);
    expect(screen.getByRole("button", { name: "English" })).toBeTruthy();
  });

  it("flips data-theme between dark and light", () => {
    wrap(<Header {...headerProps(board)} />);
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(root.getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("calls onTogglePause and labels the button Pause or Resume from the flag", () => {
    const onTogglePause = vi.fn();
    const { rerender } = wrap(<Header {...headerProps(board, { onTogglePause })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    expect(onTogglePause).toHaveBeenCalledTimes(1);
    rerender(
      <LangProvider>
        <Header {...headerProps(board, { onTogglePause, paused: true })} />
      </LangProvider>,
    );
    expect(screen.getByRole("button", { name: "Resume motion" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("owns a paused flag through usePaused that flips the label", async () => {
    const { usePaused } = await import("../../state/usePaused");
    function Harness() {
      const [paused, toggle] = usePaused();
      return <Header {...headerProps(board, { paused, onTogglePause: toggle })} />;
    }
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    expect(screen.getByRole("button", { name: "Resume motion" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume motion" }));
    expect(screen.getByRole("button", { name: "Pause motion" })).toBeTruthy();
  });

  it("still counts the alarms it has when the error read failed", () => {
    const unread = boardOf({ sentry: false });
    expect(unread.stations.every((s) => s.readings.alarms === "not-read")).toBe(true);
    expect(unread.alarms.length).toBeGreaterThan(0);
    wrap(<Header {...headerProps(unread)} />);
    expect(screen.getByText(`${unread.alarms.length} active alarms`)).toBeTruthy();
  });

  it("never says 0 alarms when the error read failed and none is known", () => {
    const unread = boardOf({ sentry: false }, (s) => {
      s.sentryIssues = [];
      s.monitors = [];
    });
    expect(unread.alarms).toHaveLength(0);
    wrap(<Header {...headerProps(unread)} />);
    expect(screen.queryByText(/active alarms/)).toBeNull();
    expect(screen.getByText("Error tracker not read")).toBeTruthy();
  });

  it("marks an example alarm in the count", () => {
    const withExample = buildBoard(fixture(), { now: NOW, demo: true });
    wrap(<Header {...headerProps(withExample)} />);
    expect(screen.getByText("6 active alarms (one is an example)")).toBeTruthy();
  });

  it("says no data when no lab update is known, never 0 ago", () => {
    wrap(<Header {...headerProps(board, { labUpdatedAt: null })} />);
    expect(screen.getByText(STRINGS.labUpdatedNone.en)).toBeTruthy();
    expect(screen.queryByText(/ago/)).toBeNull();
  });

  it("shows an amber stale chip with the time of the last good sync", () => {
    const earlier = new Date("2026-11-13T12:30:00Z");
    wrap(<Header {...headerProps(board, { status: "stale", asOf: earlier })} />);
    const chip = screen.getByText("Stale, last sync 14:30");
    expect(chip.className).toContain("stale");
    expect(screen.getByText("As of last sync, 14:30")).toBeTruthy();
  });

  it("shows a bare amber Stale chip when there has been no good sync", () => {
    wrap(<Header {...headerProps(board, { status: "stale", asOf: null })} />);
    expect(screen.getByText("Stale").className).toContain("stale");
    expect(screen.queryByText(/As of last sync/)).toBeNull();
  });

  it("says No alarms, not 0 active alarms, when the read succeeded and none is open", () => {
    const quiet = boardOf(null, (s) => {
      s.sentryIssues = [];
      s.monitors = [];
    });
    expect(quiet.alarms).toHaveLength(0);
    wrap(<Header {...headerProps(quiet)} />);
    expect(screen.getByText("No alarms")).toBeTruthy();
    expect(screen.queryByText(/active alarms/)).toBeNull();
  });

  it("shows no figures while loading or on error without a board", () => {
    const { container, rerender } = wrap(<Header {...headerProps(null, { status: "loading", asOf: null, labUpdatedAt: null })} />);
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/active alarms/)).toBeNull();
    rerender(
      <LangProvider>
        <Header {...headerProps(null, { status: "error", asOf: null, labUpdatedAt: null })} />
      </LangProvider>,
    );
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.getByText("Error").className).toContain("stale");
    expect(screen.getByText("Test lab, not real stores")).toBeTruthy();
  });
});

describe("Verdict", () => {
  it("shows the sentence and the three lights from the board", () => {
    const board = boardOf();
    const { container } = wrap(<Verdict board={board} status="ready" />);
    expect(screen.getByText(board.verdict.sentence.en)).toBeTruthy();
    const lights = container.querySelectorAll(".light");
    expect(lights).toHaveLength(3);
    expect(Array.from(lights).map((l) => l.getAttribute("data-tone"))).toEqual(["neutral", "neutral", "fault"]);
    expect(within(lights[0] as HTMLElement).getByText("Cashier app")).toBeTruthy();
    expect(within(lights[1] as HTMLElement).getByText("7 of 7 checks OK")).toBeTruthy();
    expect(within(lights[2] as HTMLElement).getByText("3 faults on the invoice cable, 1 inside the bridge")).toBeTruthy();
  });

  it("renders the Arabic sentence and light names after the switch", () => {
    const board = boardOf();
    function Switch() {
      const { setLang } = useLang();
      return (
        <button type="button" onClick={() => setLang("ar")}>
          go
        </button>
      );
    }
    wrap(
      <>
        <Switch />
        <Verdict board={board} status="ready" />
      </>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText(board.verdict.sentence.ar)).toBeTruthy();
    expect(ARABIC.test(board.verdict.sentence.ar)).toBe(true);
    expect(screen.getByText("تطبيق الكاشير")).toBeTruthy();
    expect(screen.getByText("الحسابات")).toBeTruthy();
  });

  it("draws unknown as amber, never green or neutral, when the error read failed", () => {
    const board = boardOf({ sentry: false });
    const { container } = wrap(<Verdict board={board} status="ready" />);
    const tones = Array.from(container.querySelectorAll(".light")).map((l) => l.getAttribute("data-tone"));
    expect(tones).toContain("unknown");
    expect(tones.filter((t) => t === "neutral")).toEqual([]);
    expect(container.querySelector(".light[data-tone='unknown']")?.className).toContain("tone-unknown");
    expect(container.textContent).not.toMatch(/green|healthy/i);
  });

  it("shows a stale note and keeps the sentence when stale", () => {
    const board = boardOf();
    wrap(<Verdict board={board} status="stale" />);
    expect(screen.getByText(board.verdict.sentence.en)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Showing the last good snapshot");
  });

  it("shows busy placeholders without numbers while loading", () => {
    const { container } = wrap(<Verdict board={null} status="loading" />);
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("says plainly that Port cannot be read when there is no board", () => {
    const { container } = wrap(<Verdict board={null} status="error" />);
    expect(container.textContent).toContain("Cannot read Port.");
    expect(container.textContent).not.toMatch(/\d/);
    expect(container.querySelector(".verdict")?.getAttribute("aria-busy")).not.toBe("true");
  });
});

describe("Trace", () => {
  const series = [11, 13, 3, 11, 12, 26, 26, 20, 61, 48, 54, 132, 480];
  const stats = traceStats(series, "count");
  const runs: TraceView = { key: "runs", series, ...stats };

  it("draws 13 completed days, marks the spike and explains it", () => {
    expect(stats.spikes).toContain(12);
    const { container } = wrap(<Trace trace={runs} paused={false} />);
    const line = container.querySelector("polyline.line")!;
    expect(line.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(13);
    expect(container.querySelectorAll("circle.spike")).toHaveLength(stats.spikes.length);
    expect(container.querySelector("circle.spike title")?.textContent).toContain(String(series[stats.spikes[0]]));
    expect(container.textContent).toContain("Spike 480");
    expect(container.textContent).toContain(STRINGS.spikeNote.en);
    expect(container.querySelector("rect.band")).toBeTruthy();
  });

  it("shows yesterday and the 13-day average", () => {
    const { container } = wrap(<Trace trace={runs} paused={false} />);
    expect(container.querySelector(".trace-v")?.textContent).toBe("480yesterday");
    expect(container.textContent).toContain(`13-day avg ${runs.average.toFixed(1)}`);
  });

  it("marks failures above 2 in red and draws no spike markers", () => {
    const fseries = [2, 2, 0, 1, 2, 0, 1, 1, 2, 0, 1, 3, 2];
    const fails: TraceView = { key: "fails", series: fseries, ...traceStats(fseries, "failures") };
    const { container } = wrap(<Trace trace={fails} paused={false} />);
    expect(container.querySelectorAll("circle.badpt")).toHaveLength(1);
    expect(container.querySelectorAll("circle.spike")).toHaveLength(0);
    expect(container.querySelector("polyline.line")?.getAttribute("class")).toContain("badline");
  });

  it("pulses the last point unless paused", () => {
    const { container, rerender } = wrap(<Trace trace={runs} paused={false} />);
    expect(container.querySelector("circle.now")).toBeTruthy();
    expect(container.querySelector(".trace-cell")?.getAttribute("data-paused")).toBe("false");
    rerender(
      <LangProvider>
        <Trace trace={runs} paused />
      </LangProvider>,
    );
    expect(container.querySelector(".trace-cell")?.getAttribute("data-paused")).toBe("true");
  });

  it("draws once: after the draw animation ends, Pause and Resume do not replay it", () => {
    const { container, rerender } = wrap(<Trace trace={runs} paused={false} />);
    const line = () => container.querySelector("polyline.line")!;
    expect(line().getAttribute("class")).not.toContain("drawn");
    fireEvent.animationEnd(line());
    expect(line().getAttribute("class")).toContain("drawn");
    for (const paused of [true, false]) {
      rerender(
        <LangProvider>
          <Trace trace={runs} paused={paused} />
        </LangProvider>,
      );
      expect(line().getAttribute("class")).toContain("drawn");
    }
  });

  it("uses the mockup's cut-cable, bell and broken-code icons for faults, never green", () => {
    const board = boardOf();
    const faulty = {
      ...board,
      verdict: {
        ...board.verdict,
        lights: {
          cashier: { ...board.verdict.lights.cashier, tone: "fault" as const },
          backend: { ...board.verdict.lights.backend, tone: "fault" as const },
          accounts: board.verdict.lights.accounts,
        },
      },
    };
    const { container } = wrap(<Verdict board={faulty} status="ready" />);
    const paths = Array.from(container.querySelectorAll(".light path")).map((p) => p.getAttribute("d"));
    expect(paths[0]).toBe("M6 5L2 9l4 4M12 5l4 4-4 4M10 3L8 15");
    expect(paths[1]).toMatch(/^M9 2a4 4 0 0 0-4 4v3/);
    expect(paths[2]).toBe("M1 9h5M12 9h5M6 5v8M12 5v8M9 3l-1 3M9 15l1-3");
  });

  it("has a text alternative with the values", () => {
    wrap(<Trace trace={runs} paused={false} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(series.join(", "));
  });
});

describe("Telemetry", () => {
  it("draws the four traces of the board, titled in the current language", () => {
    const board = boardOf();
    const { container } = wrap(<Telemetry board={board} paused={false} />);
    expect(container.querySelectorAll("svg.trace")).toHaveLength(4);
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Telemetry, last 13 full days");
    for (const text of ["Changes merged per day", "CI runs per day", "CI failures per day", "Tasks done per day"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText(/Normal band 0 to 2/)).toBeTruthy();
    // 13 completed days each: today (partial) is never drawn.
    for (const line of Array.from(container.querySelectorAll("polyline.line"))) {
      expect(line.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(13);
    }
    const dots = container.querySelectorAll(".trace-v");
    board.telemetry.forEach((tr, i) => expect(dots[i].textContent).toBe(`${tr.yesterday}yesterday`));
  });

  it("shows busy placeholders, no numbers, without a board", () => {
    const { container } = wrap(<Telemetry board={null} paused={false} />);
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(container.querySelectorAll("svg.trace")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\d/);
  });
});

describe("act wrapper sanity", () => {
  it("renders inside act without warnings", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      wrap(<Header {...headerProps(boardOf())} />);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

// A stateful host, like App, so a Header toggle reaches a consumer of the flag.
describe("pause reaches the telemetry", () => {
  it("passes the flag from the header button to the traces", async () => {
    const { usePaused } = await import("../../state/usePaused");
    const board = boardOf();
    function Host() {
      const [paused, toggle] = usePaused();
      return (
        <>
          <Header {...headerProps(board, { paused, onTogglePause: toggle })} />
          <Telemetry board={board} paused={paused} />
        </>
      );
    }
    const { container } = wrap(<Host />);
    expect(container.querySelector(".trace-cell")?.getAttribute("data-paused")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    expect(container.querySelector(".trace-cell")?.getAttribute("data-paused")).toBe("true");
  });
});
