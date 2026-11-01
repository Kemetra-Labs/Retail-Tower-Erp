/**
 * Overview landing (the shell index route). Extracted from AppShell's inline
 * default so it can be the `/` index element alongside the RF-2 nested routes
 * (T009). Reads scope from RF-1's provider; renders no authorization opinion.
 * RT-559: the scope line stays the first fact (AC-1); the spec 009 panels
 * follow it. RT-969: the title and scope line are the shared page header;
 * RT-970: the panels render it, so Refresh sits among the header's actions.
 * RT-993 (DESIGN.md §12.3-§12.4): the title greets the signed-in user by name,
 * or stays the page name when the context has none.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { OverviewPanels } from "@/overview/OverviewPanels";

export function Overview(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenant = <bdi>{context?.active_tenant?.name}</bdi>;
  const name = context?.user?.display_name?.trim();
  return (
    <OverviewPanels
      title={
        name ? t.rich("overview.greeting", { name: <bdi>{name}</bdi> }) : t("shell.overview.title")
      }
      scope={
        context?.active_store ? <bdi>{context.active_store.name}</bdi> : t("overview.kpi.scopeAll")
      }
      subtitle={
        context?.active_store
          ? t.rich("shell.overview.scope", {
              tenant,
              store: <bdi>{context.active_store.name}</bdi>,
            })
          : tenant
      }
    />
  );
}
