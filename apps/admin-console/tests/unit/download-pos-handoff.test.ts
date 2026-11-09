import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HAND_OFF_TTL_MS, handOffDownload } from "../../src/devices/handOffDownload";

const URL_SENTINEL = "https://bucket.s3.eu-central-1.amazonaws.com/POS.exe?X-Amz-Signature=SECRET";

describe("handOffDownload (RT-1304 spec 7.3, AC 9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("adds one hidden, sandboxed, referrer-less iframe pointing at the link", () => {
    handOffDownload(URL_SENTINEL);
    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const frame = frames[0] as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(URL_SENTINEL);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("tabindex")).toBe("-1");
    expect(frame.getAttribute("sandbox")).toBe("allow-downloads");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hidden).toBe(true);
  });

  test("the cleanup removes it, and so does the TTL", () => {
    const cleanup = handOffDownload(URL_SENTINEL);
    cleanup();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    handOffDownload(URL_SENTINEL);
    vi.advanceTimersByTime(HAND_OFF_TTL_MS + 1);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  test("a second hand-off replaces the first frame: at most one link is in the document", () => {
    handOffDownload(URL_SENTINEL);
    handOffDownload(`${URL_SENTINEL}2`);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  test("the URL reaches nothing but the frame's src, and only until cleanup", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleanup = handOffDownload(URL_SENTINEL);
    expect(document.body.innerHTML.split("SECRET").length - 1).toBe(1);
    cleanup();
    expect(document.documentElement.outerHTML).not.toContain("SECRET");
    expect(window.location.href).not.toContain("SECRET");
    expect(
      window.history.state === null || !JSON.stringify(window.history.state).includes("SECRET"),
    ).toBe(true);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("SECRET");
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("SECRET");
    for (const spy of [log, warn, error]) expect(spy).not.toHaveBeenCalled();
  });

  test("a link that is not https is refused and nothing is added", () => {
    expect(() => handOffDownload("javascript:alert(1)")).toThrow();
    expect(() => handOffDownload("http://insecure.example/x")).toThrow();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
