import { Banner } from "@/components/Banner";
import { LedgerField } from "@/components/DetailPanel";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { type MessageKey, useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { consoleCancelVoucher } from "@/lib/client";
/**
 * RT-1109 voucher detail drawer: value, effective status, eligibility, expiry,
 * batch and the current redemption (always null until RT-1111/RT-1112 ship).
 * The code is never here: `Voucher` has no code property.
 *
 * Cancel (decision 5A): offered while the voucher is stored `active`, including
 * one whose expiry has passed (it reads `expired`). Friction follows consequence
 * (UX-05.2): a quiet destructive start, then an explicit confirm step naming the
 * consequence, with "Keep the voucher" as the safe choice.
 *
 * Cancel is replayable: the Idempotency-Key belongs to this voucher's cancel,
 * not to the click. A retry after a dropped answer, a 425 or a 5xx reuses it
 * and replays the stored 200; a terminal answer drops it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { VoucherEligibilityText, VoucherStatusBadge } from "./VoucherParts";
import { type VoucherReadError, useVoucher, voucherQueryKeys } from "./useVouchers";
import { type VoucherRow, canCancelVoucher, formatVoucherAmount } from "./voucherLogic";
import { classifyCancelOutcome, newIdempotencyKey } from "./voucherOutcomes";

type Store = { id: string; name?: string };

const READ_ERROR: Record<VoucherReadError["kind"], MessageKey> = {
  session: "vouchers.errors.session",
  forbidden: "vouchers.errors.forbidden",
  notFound: "vouchers.detail.notFound",
  generic: "vouchers.detail.loadFailed",
};

type Notice = {
  variant: "success" | "danger" | "warning";
  messageKey: MessageKey;
  requestId?: string;
};

export interface VoucherDetailProps {
  tenantId: string;
  voucherId: string;
  stores: readonly Store[];
  onClose: () => void;
  onCancelled: () => void;
}

function RedemptionFacts({ voucher }: Readonly<{ voucher: VoucherRow }>): React.JSX.Element | null {
  const t = useT();
  const redemption = voucher.redemption;
  if (!redemption) return null;
  return (
    <>
      <LedgerField label={t("vouchers.detail.redeemedAt")}>
        {formatDateTime(redemption.redeemed_at)}
      </LedgerField>
      <LedgerField label={t("vouchers.detail.applied")} money>
        <bdi dir="ltr">
          {formatVoucherAmount(redemption.applied_amount_minor, voucher.currency_code)}
        </bdi>
      </LedgerField>
      <LedgerField label={t("vouchers.detail.forfeited")} money>
        <bdi dir="ltr">
          {formatVoucherAmount(redemption.forfeited_amount_minor, voucher.currency_code)}
        </bdi>
      </LedgerField>
    </>
  );
}

function VoucherFacts({
  voucher,
  stores,
}: Readonly<{ voucher: VoucherRow; stores: readonly Store[] }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="surface__detail">
      <LedgerField label={t("vouchers.detail.value")} money>
        <bdi dir="ltr">{formatVoucherAmount(voucher.amount_minor, voucher.currency_code)}</bdi>
      </LedgerField>
      <LedgerField label={t("vouchers.detail.status")}>
        <VoucherStatusBadge status={voucher.status} />
      </LedgerField>
      <LedgerField label={t("vouchers.detail.validIn")}>
        <VoucherEligibilityText row={voucher} stores={stores} />
      </LedgerField>
      <LedgerField label={t("vouchers.detail.expires")}>
        {voucher.expires_at ? formatDateTime(voucher.expires_at) : t("vouchers.list.noExpiry")}
      </LedgerField>
      <LedgerField label={t("vouchers.detail.issued")}>
        {formatDateTime(voucher.created_at)}
      </LedgerField>
      {voucher.cancelled_at ? (
        <LedgerField label={t("vouchers.detail.cancelledAt")}>
          {formatDateTime(voucher.cancelled_at)}
        </LedgerField>
      ) : null}
      <RedemptionFacts voucher={voucher} />
      <LedgerField label={t("vouchers.detail.note")}>
        {voucher.note ? <bdi>{voucher.note}</bdi> : t("vouchers.detail.noNote")}
      </LedgerField>
      <LedgerField label={t("vouchers.detail.batch")} mono>
        <bdi dir="ltr">{voucher.batch_id}</bdi>
      </LedgerField>
      <LedgerField label={t("vouchers.detail.voucherId")} mono>
        <bdi dir="ltr">{voucher.voucher_id}</bdi>
      </LedgerField>
    </dl>
  );
}

function CancelControl({
  confirming,
  pending,
  onStart,
  onConfirm,
  onKeep,
}: Readonly<{
  confirming: boolean;
  pending: boolean;
  onStart: () => void;
  onConfirm: () => void;
  onKeep: () => void;
}>): React.JSX.Element {
  const t = useT();
  if (!confirming) {
    return (
      <div className="vouchers__actions">
        <button type="button" className="btn-danger-quiet" onClick={onStart}>
          {t("vouchers.detail.cancel")}
        </button>
      </div>
    );
  }
  return (
    <section className="vouchers__confirm" aria-label={t("vouchers.detail.cancel")}>
      <p>{t("vouchers.detail.cancelPrompt")}</p>
      <div className="vouchers__actions">
        <GatedButton type="button" className="btn-destructive" busy={pending} onClick={onConfirm}>
          {t("vouchers.detail.cancelConfirm")}
        </GatedButton>
        <button type="button" className="btn-ghost" onClick={onKeep} disabled={pending}>
          {t("vouchers.detail.cancelKeep")}
        </button>
      </div>
    </section>
  );
}

export function VoucherDetail({
  tenantId,
  voucherId,
  stores,
  onClose,
  onCancelled,
}: Readonly<VoucherDetailProps>): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const { voucher, isLoading, error } = useVoucher(tenantId, voucherId);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const cancelKey = useRef<string | undefined>(undefined);

  async function cancel(): Promise<void> {
    cancelKey.current ??= newIdempotencyKey();
    setPending(true);
    setNotice(undefined);
    try {
      const outcome = classifyCancelOutcome(
        await consoleCancelVoucher(voucherId, cancelKey.current),
      );
      if (outcome.kind === "cancelled") {
        cancelKey.current = undefined;
        setConfirming(false);
        setNotice({
          variant: "success",
          messageKey: outcome.alreadyCancelled
            ? "vouchers.detail.alreadyCancelled"
            : "vouchers.detail.cancelled",
        });
        await queryClient.invalidateQueries({
          queryKey: voucherQueryKeys.detail(tenantId, voucherId),
        });
        onCancelled();
        return;
      }
      if (!outcome.keepKey) {
        cancelKey.current = undefined;
        setConfirming(false);
      }
      setNotice({
        variant: "danger",
        messageKey: outcome.messageKey,
        requestId: outcome.requestId,
      });
    } catch {
      // No answer: the cancel may have landed; the same key replays it.
      setNotice({ variant: "danger", messageKey: "vouchers.detail.cancelFailed" });
    } finally {
      setPending(false);
    }
  }

  let body: React.ReactNode;
  if (isLoading) {
    body = <ListState state="loading" label={t("vouchers.detail.loading")} />;
  } else if (error || !voucher) {
    body = (
      <Banner
        variant="danger"
        message={t(READ_ERROR[error?.kind ?? "generic"])}
        requestId={error?.requestId}
      />
    );
  } else {
    body = (
      <>
        <VoucherFacts voucher={voucher} stores={stores} />
        <p className="content__sub">{t("vouchers.detail.codeNote")}</p>
        {canCancelVoucher(voucher.status) ? (
          <CancelControl
            confirming={confirming}
            pending={pending}
            onStart={() => setConfirming(true)}
            onConfirm={() => void cancel()}
            onKeep={() => setConfirming(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <Drawer title={t("vouchers.detail.title")} onClose={onClose} dismissible={!pending}>
      {notice ? (
        <Banner
          variant={notice.variant}
          message={t(notice.messageKey)}
          requestId={notice.requestId}
        />
      ) : null}
      {body}
    </Drawer>
  );
}
