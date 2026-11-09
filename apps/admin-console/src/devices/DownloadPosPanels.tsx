/**
 * RT-1304: the static and result panels of the Download POS page. The release ledger
 * shows only what the 200 returned that is safe to show (never the link, never
 * `expiresAt`). The guidance panels state what the Console cannot observe: that the
 * installer is pilot-signed, that Windows trusts it only on an admitted device, and how
 * to check the SHA-256 (spec §9).
 */
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { useT } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { type ReleaseFacts, formatSizeMb, groupSha } from "./downloadPosLogic";
import "./downloadPos.css";

/** The product and platform are fixed facts of the pilot installer, not translated copy. */
const PRODUCT = "POS Pulse";
const PLATFORM = "Windows 10 22H2 x64 / Windows 11 x64";
const VERIFY_COMMAND = "Get-FileHash -Algorithm SHA256 .\\POS-Pulse-Setup-*.exe";

/** How long the polite "copied" line stays before it clears, so the next copy is announced again. */
const ANNOUNCE_MS = 3000;

type CopyNotice = "copied" | "manual" | null;

function selectContents(node: HTMLElement | null): void {
  const selection = window.getSelection();
  if (!node || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function CopySha({
  sha,
  codeRef,
}: Readonly<{ sha: string; codeRef: React.RefObject<HTMLElement | null> }>): React.JSX.Element {
  const t = useT();
  const [notice, setNotice] = useState<CopyNotice>(null);
  useEffect(() => {
    if (notice === null) return undefined;
    const id = setTimeout(() => setNotice(null), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [notice]);
  const copy = async (): Promise<void> => {
    setNotice(null);
    try {
      await navigator.clipboard.writeText(sha);
      setNotice("copied");
    } catch {
      // The clipboard refused: select the text so the operator can copy it, and say so.
      selectContents(codeRef.current);
      setNotice("manual");
    }
  };
  const message = {
    copied: t("devices.download.copied"),
    manual: t("devices.download.copyManual"),
  };
  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => void copy()}>
        {t("devices.download.copy")}
      </button>
      <output className="sr-only">{notice ? message[notice] : ""}</output>
    </>
  );
}

export function ReleaseLedger({ facts }: Readonly<{ facts: ReleaseFacts }>): React.JSX.Element {
  const t = useT();
  const shaRef = useRef<HTMLElement>(null);
  return (
    <dl className="surface__detail">
      <LedgerField label={t("devices.download.field.version")} mono>
        <bdi dir="ltr">{facts.version}</bdi>
      </LedgerField>
      <LedgerField label={t("devices.download.field.fileName")} mono>
        <bdi dir="ltr">{facts.fileName}</bdi>
      </LedgerField>
      <LedgerField label={t("devices.download.field.size")}>
        <bdi dir="ltr">{formatSizeMb(facts.sizeBytes)}</bdi>
      </LedgerField>
      <LedgerField label={t("devices.download.field.sha256")} mono>
        <span className="download-pos__sha">
          <bdi dir="ltr">
            <code ref={shaRef}>{groupSha(facts.sha256)}</code>
          </bdi>
          <CopySha sha={facts.sha256} codeRef={shaRef} />
        </span>
      </LedgerField>
      <LedgerField label={t("devices.download.field.publisher")} mono>
        <bdi dir="ltr">{facts.expectedPublisher}</bdi>
      </LedgerField>
    </dl>
  );
}

export function ProductFacts(): React.JSX.Element {
  const t = useT();
  return (
    <dl className="surface__detail">
      <LedgerField label={t("devices.download.field.product")}>
        <bdi dir="ltr">{PRODUCT}</bdi>
      </LedgerField>
      <LedgerField label={t("devices.download.field.platform")}>
        <bdi dir="ltr">{PLATFORM}</bdi>
      </LedgerField>
    </dl>
  );
}

export function BeforeInstallPanel(): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id="download-before" title={t("devices.download.panel.before")}>
      <PanelBody>
        <ul className="download-pos__guidance">
          <li>{t("devices.download.before.signed")}</li>
          <li>{t("devices.download.before.trust")}</li>
          <li>{t("devices.download.before.warning")}</li>
        </ul>
      </PanelBody>
    </DetailPanel>
  );
}

export function VerifyPanel(): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id="download-verify" title={t("devices.download.panel.verify")}>
      <PanelBody>
        <p>{t("devices.download.verify.step")}</p>
        <bdi dir="ltr">
          <code className="download-pos__command">{VERIFY_COMMAND}</code>
        </bdi>
        <p>{t("devices.download.verify.mismatch")}</p>
      </PanelBody>
    </DetailPanel>
  );
}

/** The last step and the support line: plain text only, no address, phone or link (O-1). */
export function InstallPanel(): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id="download-install" title={t("devices.download.panel.install")}>
      <PanelBody>
        <p>
          {t.rich("devices.download.install.step", {
            pairing: (
              <Link to="/devices/pairing-codes" className="download-pos__link">
                {t("devices.list.pairingCodes")}
              </Link>
            ),
          })}
        </p>
        <p className="content__sub">{t("devices.download.support")}</p>
      </PanelBody>
    </DetailPanel>
  );
}
