/**
 * RT-1338: a side drawer that holds one small form (the brand drawer, the offer pause drawer). It is
 * the `Drawer` primitive with its notices above a plain `FormPanel` (a drawer's panel drops its
 * surface: panels never nest). Whether the drawer may be dismissed is the caller's: a request in
 * flight must not be lost to Escape or the scrim.
 */
import { Banner, type BannerVariant } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { FormPanel } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";

interface DrawerNotice {
  variant: BannerVariant;
  messageKey: MessageKey;
  requestId?: string;
}

export interface FormDrawerProps {
  title: string;
  onClose: () => void;
  /** False while closing would lose work (a request in flight). */
  dismissible: boolean;
  /** A standing note above the form. */
  note?: React.ReactNode;
  /** The last refusal or outcome, in catalog copy, with its request id. */
  notice?: DrawerNotice;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** The primary action's label; Cancel follows it. */
  submitLabel: string;
  /** The primary action's button class (a destructive one uses `btn-destructive`). */
  submitClass?: string;
  /** A request is in flight: the primary action shows busy and Cancel is off. */
  pending: boolean;
  children: React.ReactNode;
}

export function FormDrawer({
  title,
  onClose,
  dismissible,
  note,
  notice,
  onSubmit,
  submitLabel,
  submitClass = "btn-primary",
  pending,
  children,
}: Readonly<FormDrawerProps>): React.JSX.Element {
  const t = useT();
  return (
    <Drawer title={title} onClose={onClose} dismissible={dismissible}>
      {note}
      {notice ? (
        <Banner
          variant={notice.variant}
          message={t(notice.messageKey)}
          requestId={notice.requestId}
        />
      ) : null}
      <FormPanel
        variant="plain"
        onSubmit={onSubmit}
        actions={
          <>
            <GatedButton type="submit" className={submitClass} busy={pending}>
              {submitLabel}
            </GatedButton>
            <button type="button" className="btn-ghost" disabled={pending} onClick={onClose}>
              {t("common.cancel")}
            </button>
          </>
        }
      >
        {children}
      </FormPanel>
    </Drawer>
  );
}
