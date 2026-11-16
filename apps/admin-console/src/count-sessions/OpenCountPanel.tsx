/**
 * RT-1425 — open a Count Session: choose the whole products to count (a catalog
 * search, never a typed id), add an optional note, and open it. A product is counted
 * across every position of the store (G6-1). A tracked product is marked here, but
 * the server decides: its typed refusal (`count_tracked_product_refused`) is shown
 * as sent, never pre-empted (G6-3). One Idempotency-Key per intended command.
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { Machine } from "@/inventory/parts";
import { useInventoryScope } from "@/inventory/useInventory";
import { type CatalogProduct, consoleListCatalogProducts } from "@/lib/catalog-queries";
import { createCountSession } from "@/lib/count-session-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { OutcomeBanner } from "./CountParts";
import { type CountOutcome, settlesAttempt } from "./countLogic";
import { useCountCommand } from "./useCounts";

const SEARCH_LIMIT = 25;
const NOTE_MAX = 500;

type Picked = Readonly<Record<string, CatalogProduct>>;

function ProductSearch({
  picked,
  onToggle,
}: Readonly<{ picked: Picked; onToggle: (p: CatalogProduct) => void }>) {
  const t = useT();
  const scope = useInventoryScope();
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState("");
  const results = useQuery({
    queryKey: ["count-products", scope.tenantId, "search", term],
    retry: false,
    queryFn: async () => {
      const res = await consoleListCatalogProducts({
        status: "active",
        limit: SEARCH_LIMIT,
        ...(term ? { q: term } : {}),
      });
      if (res.status !== 200 || !res.data) throw new Error("search");
      return res.data.items;
    },
  });
  return (
    <div className="counts__picker">
      <div className="counts__search">
        <div className="field">
          <label htmlFor="count-product-search">{t("counts.open.search")}</label>
          <input
            id="count-product-search"
            className="input"
            type="search"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setTerm(draft.trim());
              }
            }}
          />
        </div>
        <button type="button" className="btn-secondary" onClick={() => setTerm(draft.trim())}>
          {t("counts.open.searchAction")}
        </button>
      </div>
      {results.isLoading ? (
        <ListState state="loading" label={t("counts.open.loadingNoun")} />
      ) : null}
      {results.isError ? (
        <p role="alert" className="counts__note">
          {t("counts.open.searchFailed")}
        </p>
      ) : null}
      {results.data && results.data.length === 0 ? (
        <ListState state="empty" emptyMessage={t("counts.open.noProducts")} />
      ) : null}
      {results.data && results.data.length > 0 ? (
        <fieldset className="counts__results">
          <legend>{t("counts.open.results")}</legend>
          {results.data.map((p) => (
            <label key={p.productId} className="counts__result">
              <input
                type="checkbox"
                checked={Object.hasOwn(picked, p.productId)}
                onChange={() => onToggle(p)}
              />
              <bdi dir="auto">{p.name}</bdi>
              {p.primarySku ? <Machine value={p.primarySku} /> : null}
              {p.trackingMode === "none" ? null : (
                <span className="badge badge--warning">{t("counts.open.tracked")}</span>
              )}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

export function OpenCountPanel({
  storeId,
  index,
  onOpened,
}: Readonly<{ storeId: string; index?: number; onOpened: (sessionId: string) => void }>) {
  const t = useT();
  const command = useCountCommand();
  const attempt = useRef(new KeyedAttempt());
  const [picked, setPicked] = useState<Picked>({});
  const [note, setNote] = useState("");
  const [empty, setEmpty] = useState(false);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);
  const ids = Object.keys(picked);

  const toggle = (p: CatalogProduct) => {
    setEmpty(false);
    setPicked((cur) => {
      const { [p.productId]: removed, ...rest } = cur;
      return removed ? rest : { ...cur, [p.productId]: p };
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (ids.length === 0) return setEmpty(true);
    const trimmed = note.trim();
    const body = {
      scope: { kind: "products" as const, productIds: ids },
      ...(trimmed ? { note: trimmed } : {}),
    };
    const key = attempt.current.keyFor(JSON.stringify(body));
    const result = await command.run(() => createCountSession(storeId, body, key));
    setOutcome(result);
    if (settlesAttempt(result)) attempt.current.settle();
    if (result.kind === "ok" && result.data) onOpened(result.data.id);
  };

  return (
    <DetailPanel id="counts-open" index={index} title={t("counts.open.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.open.sub")}</p>
        <ProductSearch picked={picked} onToggle={toggle} />
        <form className="surface__form" onSubmit={submit} noValidate>
          <p aria-live="polite" className="counts__selected">
            {t("counts.open.selected", { count: ids.length })}
          </p>
          <InlineError message={empty ? t("counts.open.error.empty") : undefined} />
          <div className="field">
            <label htmlFor="count-note">
              {t("counts.open.note")}
              <span className="field__required"> {t("counts.optional")}</span>
            </label>
            <textarea
              id="count-note"
              className="input"
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <OutcomeBanner outcome={outcome} title={t("counts.open.failed")} />
          <GatedButton type="submit" className="btn-primary" busy={command.isPending}>
            {command.isPending ? t("common.loading") : t("counts.open.submit")}
          </GatedButton>
        </form>
      </div>
    </DetailPanel>
  );
}
