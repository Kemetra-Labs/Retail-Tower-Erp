/**
 * RT-1329: the "Releases" panel of the POS pilot page. Every registered release,
 * newest first as the server lists it, withdrawn rows included. Activate is
 * offered on an approved release that is neither withdrawn nor current, behind
 * an inline confirm naming the version. There is no Withdraw control (D-5a).
 */
import { Banner } from "@/components/Banner";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { DateTime, type T, formatNumber, useT } from "@/i18n";
import type { PilotRelease } from "@/lib/pilot-platform-types";
import { useState } from "react";
import { useClaimRateLimit } from "../rateLimitOwner";
import { PilotConfirm, type PilotNotice, commonNotice } from "./PilotConfirm";
import { PilotListBody } from "./PilotListBody";
import { type ActivateKind, canActivate, evidenceHref, releaseState, shortSha } from "./pilotLogic";
import { type WriteOutcome, useActivateRelease, usePilotReleases } from "./usePosPilot";

const MB = 1024 * 1024;

function sizeOf(t: T, bytes: number): string {
  return t("posPilot.releases.size", { size: formatNumber(Math.round((bytes / MB) * 10) / 10) });
}

function noticeOf(t: T, outcome: WriteOutcome<ActivateKind>, version: string): PilotNotice {
  switch (outcome.kind) {
    case "activated":
      return { variant: "success", message: t("posPilot.activate.done", { version }) };
    case "currentExists":
      return { variant: "warning", message: t("posPilot.activate.currentExists", { version }) };
    case "withdrawn":
      return { variant: "warning", message: t("posPilot.activate.withdrawn", { version }) };
    case "notFound":
      return { variant: "warning", message: t("posPilot.activate.notFound") };
    default:
      return commonNotice(t, outcome);
  }
}

function EvidenceLink({ href, label }: Readonly<{ href: string; label: string }>) {
  const safe = evidenceHref(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

const STATE_CLASS = {
  current: "badge badge--success",
  registered: "badge",
  withdrawn: "badge",
} as const;

function ReleaseRow({
  release,
  onActivate,
}: Readonly<{ release: PilotRelease; onActivate: (r: PilotRelease) => void }>) {
  const t = useT();
  const state = releaseState(release);
  return (
    <tr className="data-table__row data-table__row--static">
      <td>
        <bdi dir="ltr" className="pos-pilot__mono">
          {release.version}
        </bdi>
      </td>
      <td>
        <span className={STATE_CLASS[state]}>{t(`posPilot.releases.state.${state}`)}</span>
        {release.approved ? null : (
          <span className="pos-pilot__muted"> {t("posPilot.releases.notApproved")}</span>
        )}
      </td>
      <td>
        <DateTime value={release.registeredAt} />
      </td>
      <td>
        <bdi dir="ltr">{release.approvedBy}</bdi>
      </td>
      <td>
        <bdi dir="ltr" className="pos-pilot__mono" title={release.sha256}>
          {shortSha(release.sha256)}
        </bdi>
      </td>
      <td className="num">{sizeOf(t, release.sizeBytes)}</td>
      <td>
        <span className="pos-pilot__links">
          <EvidenceLink
            href={release.promotionRunUrl}
            label={t("posPilot.releases.evidence.run")}
          />
          <EvidenceLink
            href={release.attestationRef}
            label={t("posPilot.releases.evidence.attestation")}
          />
        </span>
      </td>
      <td>
        {canActivate(release) ? (
          <button
            type="button"
            className="btn-secondary"
            aria-label={t("posPilot.releases.activateFor", { version: release.version })}
            onClick={() => onActivate(release)}
          >
            {t("posPilot.releases.activate")}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ReleasesTable({
  releases,
  onActivate,
}: Readonly<{ releases: PilotRelease[]; onActivate: (r: PilotRelease) => void }>) {
  const t = useT();
  const captionId = useCaptionId();
  const cols = [
    "version",
    "state",
    "registered",
    "approvedBy",
    "sha",
    "size",
    "evidence",
    "action",
  ] as const;
  return (
    <DataTableScroll captionId={captionId}>
      <table className="data-table data-table--strips">
        <caption id={captionId} className="data-table__caption">
          {t("posPilot.releases.caption")}
        </caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col" className={c === "size" ? "num" : undefined}>
                {t(`posPilot.releases.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => (
            <ReleaseRow key={r.releaseId} release={r} onActivate={onActivate} />
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
}

export function ReleasesPanel(): React.JSX.Element {
  const t = useT();
  const list = usePilotReleases();
  const activate = useActivateRelease();
  const [confirming, setConfirming] = useState<PilotRelease | null>(null);
  const [notice, setNotice] = useState<PilotNotice | null>(null);
  const [claimSeq, setClaimSeq] = useState<number | undefined>(undefined);
  useClaimRateLimit(claimSeq);

  async function confirm(release: PilotRelease): Promise<void> {
    const outcome = await activate.run(release.releaseId);
    setClaimSeq(outcome.seq);
    setNotice(noticeOf(t, outcome, release.version));
    setConfirming(null);
  }

  return (
    <DetailPanel
      id="pos-pilot-releases"
      index={1}
      title={t("posPilot.releases.panelTitle")}
      aside={<p className="pos-pilot__note">{t("posPilot.releases.note")}</p>}
    >
      {notice ? (
        <Banner variant={notice.variant} message={notice.message} requestId={notice.requestId} />
      ) : null}
      {confirming ? (
        <PilotConfirm
          label={t("posPilot.activate.label")}
          prompt={t.rich("posPilot.activate.prompt", {
            version: (
              <strong>
                <bdi dir="ltr">{confirming.version}</bdi>
              </strong>
            ),
          })}
          confirmLabel={t("posPilot.activate.confirm")}
          tone="primary"
          pending={activate.pending}
          onConfirm={() => void confirm(confirming)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      <PilotListBody
        list={list}
        loadingLabel={t("posPilot.releases.panelTitle")}
        failedMessage={t("posPilot.releases.error.failed")}
        emptyMessage={t("posPilot.releases.empty")}
        emptyHint={t("posPilot.releases.emptyHint")}
      >
        {(releases) => (
          <ReleasesTable
            releases={releases}
            onActivate={(r) => {
              setNotice(null);
              setConfirming(r);
            }}
          />
        )}
      </PilotListBody>
    </DetailPanel>
  );
}
