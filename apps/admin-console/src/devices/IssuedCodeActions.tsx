/**
 * RT-1316 — Copy and "Print for installer" for the code shown once. Both carry
 * the code exactly as issued (never the grouped display form), so it works on a
 * till whatever it does with dashes.
 *
 * Copy writes the system clipboard only after a click, and says "copied" only
 * once the clipboard has accepted it. Print prints in place with `window.print()`:
 * no new window, frame or file. The printout is mounted only while printing, in a
 * sheet the print stylesheet keeps alone on the page. It holds the code, its
 * barcode, the store, the terminal label and the expiry in store time, and nothing
 * else (no receipt details).
 */
import { useT } from "@/i18n";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Code128Barcode } from "./Code128Barcode";
import { LtrTime } from "./DeviceParts";
import { groupPairingCode } from "./pairingLogic";
import "./devices.css";

export interface PrintDetails {
  code: string;
  storeName: string;
  terminalLabel: string;
  expiresAt: string;
  timeZone?: string;
}

type CopyState = "idle" | "copied" | "failed";

function PrintSheet({ details }: Readonly<{ details: PrintDetails }>): React.JSX.Element {
  const t = useT();
  return createPortal(
    <section className="device-print-sheet" aria-hidden="true">
      <h2>{t("devices.issue.print.title")}</h2>
      <dl>
        <dt>{t("devices.issue.field.store")}</dt>
        <dd>
          <bdi dir="auto">{details.storeName}</bdi>
        </dd>
        <dt>{t("devices.issue.print.terminal")}</dt>
        <dd>
          <bdi dir="auto">{details.terminalLabel}</bdi>
        </dd>
        <dt>{t("devices.issue.print.code")}</dt>
        <dd>
          <code dir="ltr" className="device-issued__value">
            {groupPairingCode(details.code)}
          </code>
        </dd>
      </dl>
      <Code128Barcode value={details.code} label={t("devices.issue.issued.barcode")} />
      <p>
        {t.rich("devices.issue.print.expires", {
          time: <LtrTime value={details.expiresAt} timeZone={details.timeZone} />,
        })}
      </p>
    </section>,
    document.body,
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function IssuedCodeActions({
  details,
}: Readonly<{ details: PrintDetails }>): React.JSX.Element {
  const t = useT();
  const [copy, setCopy] = useState<CopyState>("idle");
  const [printing, setPrinting] = useState(false);

  // The sheet is in the page now: print it, then take it out again.
  useEffect(() => {
    if (!printing) return;
    window.print();
    setPrinting(false);
  }, [printing]);

  async function copyCode(): Promise<void> {
    setCopy("idle");
    setCopy((await writeClipboard(details.code)) ? "copied" : "failed");
  }

  return (
    <div className="device-issued__actions">
      <button type="button" className="btn-secondary" onClick={() => void copyCode()}>
        {t("devices.issue.issued.copy")}
      </button>
      <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
        {t("devices.issue.issued.print")}
      </button>
      <output className={copy === "failed" ? "device-issued__copy-failed" : "device-quiet"}>
        {copy === "copied" ? t("devices.issue.issued.copied") : null}
        {copy === "failed" ? t("devices.issue.issued.copyFailed") : null}
      </output>
      {printing ? <PrintSheet details={details} /> : null}
    </div>
  );
}
