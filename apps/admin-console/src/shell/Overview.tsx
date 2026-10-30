/**
 * Overview landing (the shell index route). Extracted from AppShell's inline
 * default so it can be the `/` index element alongside the RF-2 nested routes
 * (T009). Reads scope from RF-1's provider; renders no authorization opinion.
 * RT-559: the scope line stays the first fact (AC-1); the spec 009 panels
 * follow it. RT-969: the title and scope line are the shared page header;
 * the Overview content itself is RT-970's.
 */
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { OverviewPanels } from "@/overview/OverviewPanels";

export function Overview(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenant = <bdi>{context?.active_tenant?.name}</bdi>;
  return (
    <div className="surface">
      <PageHeader
        title={t("shell.overview.title")}
        subtitle={
          context?.active_store
            ? t.rich("shell.overview.scope", {
                tenant,
                store: <bdi>{context.active_store.name}</bdi>,
              })
            : tenant
        }
      />
      <OverviewPanels />
    </div>
  );
}
