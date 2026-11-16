/**
 * RT-1425 / RT-1423 — the tenant's Count Session activation switch (G6-7). Owner and
 * tenant_admin read and change it; a store_manager reads the on/off state only (the
 * server nulls the rest) and gets no control. The state shown is ONLY what the server
 * last said: a refused switch never flips it, and a recorded one is re-read, so the
 * panel can never claim "on" while the server says off. Every refusal (the readiness
 * boundaries, an open session) reads by its machine code in Arabic or English.
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { DateTime, useT } from "@/i18n";
import { ReadError } from "@/inventory/parts";
import { type InventoryScope, useInventoryRead } from "@/inventory/useInventory";
import {
  type CountSessionsSetting,
  getCountSessionsSetting,
  setCountSessionsSetting,
} from "@/lib/count-session-queries";
import { useState } from "react";
import { OutcomeBanner, UnmetList, usePersonLabel } from "./CountParts";
import type { CountOutcome } from "./countLogic";
import { useCountCommand } from "./useCounts";

/** Who may change the switch; the server enforces it (any other role is a 403). */
function canChangeActivation(role: string | null): boolean {
  return role === "owner" || role === "tenant_admin";
}

function ActivationBody({
  setting,
  canChange,
}: Readonly<{ setting: CountSessionsSetting; canChange: boolean }>) {
  const t = useT();
  const command = useCountCommand();
  const person = usePersonLabel([setting.changedBy]);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  const change = async () => {
    setOutcome(await command.run(() => setCountSessionsSetting({ enabled: !setting.enabled })));
  };
  const unmet = setting.unmetReadiness ?? [];

  return (
    <div className="surface__form">
      <p className="counts__note" data-testid="count-activation-state">
        {t(setting.enabled ? "counts.activation.on" : "counts.activation.off")}
        {setting.changedAt && setting.changedBy ? (
          <>
            {" "}
            {t.rich("counts.activation.changed", {
              who: person(setting.changedBy),
              when: <DateTime value={setting.changedAt} />,
            })}
          </>
        ) : null}
      </p>
      {!setting.enabled && setting.readinessMet === true ? (
        <p className="counts__note">{t("counts.activation.ready")}</p>
      ) : null}
      {!setting.enabled && unmet.length > 0 ? (
        <div data-testid="count-activation-unmet">
          <p className="counts__note">{t("counts.activation.notReady")}</p>
          <UnmetList unmet={unmet} />
        </div>
      ) : null}
      {outcome?.kind === "ok" ? (
        <output className="counts__ok">{t("counts.activation.saved")}</output>
      ) : null}
      <OutcomeBanner outcome={outcome} title={t("counts.activation.failed")} />
      {canChange ? (
        <GatedButton
          type="button"
          className="btn-primary"
          busy={command.isPending}
          onClick={change}
        >
          {t(setting.enabled ? "counts.activation.turnOff" : "counts.activation.turnOn")}
        </GatedButton>
      ) : (
        <p className="counts__note">{t("counts.activation.readOnly")}</p>
      )}
    </div>
  );
}

export function ActivationSetting({
  scope,
  index,
}: Readonly<{ scope: InventoryScope; index: number }>) {
  const t = useT();
  const setting = useInventoryRead({
    queryKey: ["counts", scope.tenantId, "activation"],
    scope,
    load: getCountSessionsSetting,
  });
  let body: React.JSX.Element;
  if (setting.isLoading)
    body = <ListState state="loading" label={t("counts.activation.loadingNoun")} />;
  else if (setting.error || !setting.data) {
    body = (
      <ReadError
        error={setting.error ?? { kind: "generic" }}
        failedKey="counts.activation.loadFailed"
        notFoundKey="counts.activation.notAvailable"
        onRetry={setting.retry}
      />
    );
  } else {
    body = (
      <ActivationBody
        key={`${setting.data.enabled}-${setting.data.changedAt ?? "never"}`}
        setting={setting.data}
        canChange={canChangeActivation(scope.role)}
      />
    );
  }
  return (
    <DetailPanel id="counts-activation" index={index} title={t("counts.activation.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.activation.sub")}</p>
        {body}
      </div>
    </DetailPanel>
  );
}
