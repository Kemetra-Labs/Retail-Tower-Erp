import { useT } from "@/i18n";

/**
 * The store's V1 `is_active` state as a status badge: «نشط» / «موقوف». A
 * missing flag reads as active, matching the backend default. This is not a
 * lifecycle state (decisions 188/194). Active is neutral, like a device's
 * active trust state: an enabled flag is not a proven outcome (RT-956).
 */
export function StoreStateBadge({ isActive }: Readonly<{ isActive?: boolean }>): React.JSX.Element {
  const t = useT();
  const inactive = isActive === false;
  return (
    <span className={inactive ? "badge badge--warning" : "badge"}>
      {t(inactive ? "stores.state.inactive" : "stores.state.active")}
    </span>
  );
}
