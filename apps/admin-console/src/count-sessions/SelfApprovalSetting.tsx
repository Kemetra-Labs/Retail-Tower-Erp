/**
 * RT-1425 — the tenant owner's small-shop self-approval exception (G6-10): whether
 * a counter or the submitter may approve their own count. Off by default; enabling
 * needs a recorded reason; every change is audited by the server. Owner only: the
 * panel is offered to the owner role, and the server enforces ownership (any other
 * role is the typed 403 `count_self_approval_owner_only`, shown as sent by code).
 * There is no variance threshold and no platform override in V1.
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { DateTime, useT } from "@/i18n";
import { ReadError } from "@/inventory/parts";
import { type InventoryScope, useInventoryRead } from "@/inventory/useInventory";
import {
  type CountSelfApprovalSetting,
  getCountSelfApprovalSetting,
  setCountSelfApprovalSetting,
} from "@/lib/count-session-queries";
import { useState } from "react";
import { OutcomeBanner, usePersonLabel } from "./CountParts";
import { type CountOutcome, REASON_MAX } from "./countLogic";
import { useCountCommand } from "./useCounts";

function SettingForm({ setting }: Readonly<{ setting: CountSelfApprovalSetting }>) {
  const t = useT();
  const command = useCountCommand();
  const person = usePersonLabel([setting.changedBy]);
  const [enabled, setEnabled] = useState(setting.enabled);
  const [reason, setReason] = useState(setting.reason ?? "");
  const [missing, setMissing] = useState(false);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (enabled && !trimmed) return setMissing(true);
    setMissing(false);
    const body = enabled ? { enabled, reason: trimmed } : { enabled };
    setOutcome(await command.run(() => setCountSelfApprovalSetting(body)));
  };

  return (
    <form className="surface__form" onSubmit={save} noValidate>
      <p className="counts__note" data-testid="count-self-approval-state">
        {t(setting.enabled ? "counts.selfSetting.on" : "counts.selfSetting.off")}
        {setting.changedAt && setting.changedBy ? (
          <>
            {" "}
            {t.rich("counts.selfSetting.changed", {
              who: person(setting.changedBy),
              when: <DateTime value={setting.changedAt} />,
            })}
          </>
        ) : null}
      </p>
      <label className="counts__check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("counts.selfSetting.enable")}
      </label>
      {enabled ? (
        <div className="field">
          <label htmlFor="count-self-reason">{t("counts.selfSetting.reason")}</label>
          <textarea
            id="count-self-reason"
            className="input"
            rows={2}
            maxLength={REASON_MAX}
            value={reason}
            aria-invalid={missing ? true : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          <InlineError message={missing ? t("counts.selfSetting.error.reason") : undefined} />
        </div>
      ) : null}
      {outcome?.kind === "ok" ? (
        <output className="counts__ok">{t("counts.selfSetting.saved")}</output>
      ) : null}
      <OutcomeBanner outcome={outcome} title={t("counts.selfSetting.failed")} />
      <GatedButton type="submit" className="btn-primary" busy={command.isPending}>
        {t("counts.selfSetting.save")}
      </GatedButton>
    </form>
  );
}

export function SelfApprovalSetting({
  scope,
  index,
}: Readonly<{ scope: InventoryScope; index: number }>) {
  const t = useT();
  const setting = useInventoryRead({
    queryKey: ["counts", scope.tenantId, "self-approval"],
    scope,
    load: getCountSelfApprovalSetting,
  });
  let body: React.JSX.Element;
  if (setting.isLoading)
    body = <ListState state="loading" label={t("counts.selfSetting.loadingNoun")} />;
  else if (setting.error || !setting.data) {
    body = (
      <ReadError
        error={setting.error ?? { kind: "generic" }}
        failedKey="counts.selfSetting.loadFailed"
        notFoundKey="counts.selfSetting.notAvailable"
        onRetry={setting.retry}
      />
    );
  } else body = <SettingForm key={setting.data.changedAt ?? "never"} setting={setting.data} />;
  return (
    <DetailPanel id="counts-self-approval" index={index} title={t("counts.selfSetting.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.selfSetting.sub")}</p>
        {body}
      </div>
    </DetailPanel>
  );
}
