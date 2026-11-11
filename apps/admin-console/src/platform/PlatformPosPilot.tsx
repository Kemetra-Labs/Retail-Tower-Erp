/**
 * `/platform/pos-pilot` (RT-1329): the POS pilot release registry and tenant
 * allowlist for a platform admin. The `/platform` gate (PlatformArea) already
 * keeps everyone else out with the non-disclosing no-access state; every read
 * and write is authorized again server-side (platform admin, trusted Origin).
 *
 * Two numbered panels: the releases, with Activate behind a confirm step, and
 * the allowlist, with Add (from the platform tenant list) and Remove. No
 * Withdraw: only the promotion workflow withdraws a release (D-5a). Nothing
 * here asks for or shows a presigned download URL.
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import { AllowlistPanel } from "./pilot/AllowlistPanel";
import { ReleasesPanel } from "./pilot/ReleasesPanel";
import "./pilot/pos-pilot.css";
import "./platform.css";

export function PlatformPosPilot(): React.JSX.Element {
  const t = useT();
  return (
    <section aria-labelledby="platform-pos-pilot-title" className="pos-pilot">
      <PageHeader
        titleId="platform-pos-pilot-title"
        title={t("posPilot.title")}
        subtitle={t("posPilot.sub")}
      />
      <ReleasesPanel />
      <AllowlistPanel />
    </section>
  );
}
