/**
 * RT-1304 (spec 7.3, AC 9): hand a presigned S3 link to the browser without ever
 * navigating the Console tab to it.
 *
 * The link goes into a hidden iframe. On success S3 answers with an `attachment`
 * disposition and the browser downloads it. When S3 refuses the link (403 XML: an
 * expired link, clock skew, a missing version) the error page renders INSIDE the hidden
 * frame, so the Console tab stays on `/devices/download-pos` and the link never reaches
 * the address bar or the history. (A plain anchor would navigate the tab to that error
 * page; `fetch` is blocked by `connect-src 'self'`.) The Console CSP admits the frame
 * through the `frame-src` that RT-1305 adds for the pilot bucket's origin; without it the
 * frame is refused and nothing downloads.
 *
 * The link is a bearer capability: it lives only in this call and in the frame's `src`
 * until cleanup. It is never put in state, storage, a log or a message. The frame is
 * sandboxed with only `allow-downloads` (no scripts, no same-origin) and sends no
 * referrer. At most one frame exists at a time.
 */
export const HAND_OFF_TTL_MS = 60_000;
const FRAME_ATTR = "data-download-handoff";

export function handOffDownload(url: string, doc: Document = document): () => void {
  if (!url.startsWith("https://")) throw new Error("download link must be https");
  for (const old of doc.querySelectorAll(`iframe[${FRAME_ATTR}]`)) old.remove();

  const frame = doc.createElement("iframe");
  frame.setAttribute(FRAME_ATTR, "");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("sandbox", "allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("src", url);
  doc.body.appendChild(frame);

  const timer = setTimeout(() => frame.remove(), HAND_OFF_TTL_MS);
  return () => {
    clearTimeout(timer);
    frame.remove();
  };
}
