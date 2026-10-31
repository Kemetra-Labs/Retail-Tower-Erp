/**
 * RT-1010 «ماذا يحدث بعد الحفظ»: the short note beside the edit form. Each step
 * is true of what the page does today: `buildPatch` sends only the changed
 * fields, a store override is a separate record that a product save never
 * touches, and no price is written here.
 */
import { FormAside } from "@/components/FormPage";
import { useT } from "@/i18n";

export function ProductEditAside(): React.JSX.Element {
  const t = useT();
  return (
    <FormAside title={t("catalog.edit.after.title")}>
      <ol>
        <li>{t("catalog.edit.after.changed")}</li>
        <li>{t("catalog.edit.after.stores")}</li>
        <li>{t("catalog.edit.after.price")}</li>
      </ol>
    </FormAside>
  );
}
