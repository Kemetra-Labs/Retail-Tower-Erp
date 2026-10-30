/**
 * RT-969 (Shell v3): the Ctrl K navigator. A client-side command palette over
 * the shell's own destinations (`nav-model.ts`, already role-filtered) and the
 * stores in scope. It needs no new contract: stores come from the same query
 * and cache key as the scope menu (RT-354), loaded only while it is open.
 *
 * - Opens with Ctrl+K (⌘K on a Mac) or the top-bar button, unless another
 *   modal already owns the keyboard.
 * - A modal dialog holding a combobox and its listbox (WAI-ARIA combobox with
 *   `aria-activedescendant`): focus stays in the input; arrows move, Enter
 *   chooses, Escape closes. Tab cannot leave (the input is its only stop, or
 *   the input and the store list's retry), so `aria-modal` is honest. Focus
 *   returns to whatever held it before.
 * - A failed store list says so, with a retry, as the scope menu does; it
 *   never reads as a tenant with no stores.
 * - Choosing a page navigates (the unsaved-work blocker still guards it);
 *   choosing a store runs the same guarded scope change as the switcher, so
 *   the navigator can never change scope silently (RT-268).
 */
import { Icon, type IconNameFor } from "@/components/icons/Icon";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { useStoreList } from "@/stores/useStoreQueries";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { NavGroup } from "./nav-model";
import { scopeMenuStores } from "./scope-stores";
import { useScopeChange } from "./useScopeChange";
import "./navigator.css";

export interface ShellNavigator {
  open: boolean;
  show: () => void;
  close: () => void;
}

/** The navigator's open state, plus the global Ctrl+K / ⌘K shortcut. */
export function useShellNavigator(): ShellNavigator {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A browser's autofill sends a keydown with no `key` at all.
      const isK = e.code === "KeyK" || e.key?.toLowerCase() === "k";
      if (!isK || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      // A dialog already open (a drawer, Stay / Discard, this one) keeps the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return { open, show, close };
}

type PageIcon = IconNameFor<"md">;

interface Option {
  id: string;
  label: string;
  /** A page's path. */
  to?: string;
  icon?: PageIcon;
  /** A store choice: its id, or null for All stores. */
  storeId?: string | null;
  current?: boolean;
}

/**
 * Case- and mark-insensitive: Latin case, Arabic diacritics and tatweel are
 * ignored, and the alef, teh marbuta and alef maksura variants fold together.
 */
export function foldForSearch(text: string): string {
  return (
    text
      .toLocaleLowerCase()
      .normalize("NFKD")
      // Combining marks (Latin accents, Arabic harakat) and the tatweel.
      .replace(/\p{M}/gu, "")
      .replace(/ـ/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .trim()
  );
}

function matches(option: Option, query: string): boolean {
  return query === "" || foldForSearch(option.label).includes(query);
}

/** The top-bar button. It looks like a field but opens the dialog. */
export function NavigatorTrigger({
  navigator,
}: Readonly<{ navigator: ShellNavigator }>): React.JSX.Element {
  const t = useT();
  return (
    <button
      type="button"
      className="navigator-trigger"
      aria-haspopup="dialog"
      aria-expanded={navigator.open}
      aria-keyshortcuts="Control+K Meta+K"
      // Safari does not focus a clicked button; focus must come back here.
      onClick={(e) => {
        e.currentTarget.focus();
        navigator.show();
      }}
    >
      <Icon name="search" size="sm" className="navigator-trigger__icon" />
      <span className="navigator-trigger__label">{t("shell.navigator.open")}</span>
      <kbd className="navigator-trigger__kbd" dir="ltr">
        Ctrl K
      </kbd>
    </button>
  );
}

interface StoreOptions {
  options: Option[];
  loading: boolean;
  /** The list failed to load; `retry` asks again. */
  failed: boolean;
  retry: () => void;
}

/** The stores in scope as options: All stores first, then each store (RT-354). */
function useStoreOptions(enabled: boolean): StoreOptions {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenantId = enabled ? (context?.active_tenant?.id ?? null) : null;
  const { result, isLoading, refetch } = useStoreList(tenantId);
  if (!tenantId) return { options: [], loading: false, failed: false, retry: refetch };
  const activeStore = context?.active_store;
  const rows = result?.kind === "rows" && Array.isArray(result.rows) ? result.rows : [];
  const membership = context?.memberships?.find((m) => m.tenant_id === tenantId);
  const stores = scopeMenuStores(rows, membership, activeStore);
  return {
    loading: isLoading,
    failed: result?.kind === "error",
    retry: refetch,
    options: [
      {
        id: "store:all",
        label: t("shell.scope.allStores"),
        storeId: null,
        current: !activeStore,
      },
      ...stores.map((s) => ({
        id: `store:${s.id}`,
        label: s.name ?? s.id,
        storeId: s.id,
        current: s.id === activeStore?.id,
      })),
    ],
  };
}

export interface NavigatorDialogProps {
  groups: readonly NavGroup[];
  /** Offer the stores in scope (the tenant shell, outside a support session). */
  withStores: boolean;
  onClose: () => void;
}

export function NavigatorDialog({
  groups,
  withStores,
  onClose,
}: Readonly<NavigatorDialogProps>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const scopeChange = useScopeChange();
  const baseId = `navigator-${useId().replaceAll(":", "")}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const pages = useMemo<Option[]>(
    () =>
      groups.flatMap((g) =>
        g.entries.map((e) => ({ id: `page:${e.to}`, label: t(e.label), to: e.to, icon: e.icon })),
      ),
    [groups, t],
  );
  const stores = useStoreOptions(withStores);
  const folded = foldForSearch(query);
  const shownPages = pages.filter((o) => matches(o, folded));
  const shownStores = stores.options.filter((o) => matches(o, folded));
  const shown = [...shownPages, ...shownStores];
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const activeOption = shown[activeIndex];
  const optionId = (o: Option): string => `${baseId}-${o.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  useEffect(() => {
    // Focus moves in on open and back to its previous owner on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  useEffect(() => {
    if (!activeOption) return;
    document.getElementById(optionId(activeOption))?.scrollIntoView?.({ block: "nearest" });
  });

  // A click on the scrim itself (not the dialog) closes.
  useEffect(() => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    const closeOnScrim = (e: MouseEvent): void => {
      if (e.target === scrim) onClose();
    };
    scrim.addEventListener("click", closeOnScrim);
    return () => scrim.removeEventListener("click", closeOnScrim);
  }, [onClose]);

  const choose = (option: Option | undefined): void => {
    if (!option) return;
    onClose();
    if (option.to !== undefined) {
      navigate(option.to);
    } else if (option.storeId !== undefined) {
      void scopeChange(option.storeId);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // A key that confirms an IME composition belongs to the text, not the list
    // (229 covers browsers that report isComposing false on that keydown).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const last = shown.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(activeIndex <= 0 ? Math.max(last, 0) : activeIndex - 1);
        break;
      case "Enter":
        e.preventDefault();
        choose(activeOption);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "Tab":
        // Tab stays in the dialog (aria-modal): on the input, or on to the
        // store list's retry when there is one.
        e.preventDefault();
        retryRef.current?.focus();
        break;
      default:
    }
  };

  const renderOption = (option: Option): React.JSX.Element => {
    const selected = option === activeOption;
    return (
      <div
        key={option.id}
        id={optionId(option)}
        // biome-ignore lint/a11y/useSemanticElements: a native <option> lives only in a <select>; this listbox is driven by the combobox (aria-activedescendant).
        role="option"
        // Never a Tab stop: the combobox keeps focus and points at the active option.
        tabIndex={-1}
        aria-selected={selected}
        className={`navigator__option${selected ? " navigator__option--active" : ""}`}
        // Keep focus in the input when an option is pressed.
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => {
          if (!selected) setActive(shown.indexOf(option));
        }}
        onClick={() => choose(option)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          choose(option);
        }}
      >
        <Icon name={option.icon ?? "store"} className="navigator__icon" />
        <span className="navigator__label">
          <bdi>{option.label}</bdi>
        </span>
        {option.current ? (
          <>
            <Icon name="confirm" size="sm" className="navigator__current" />
            <span className="sr-only">{t("shell.navigator.current")}</span>
          </>
        ) : null}
      </div>
    );
  };

  /** One labelled group of options (WAI-ARIA APG "Listbox with Grouped Options"). */
  const renderGroup = (headingId: string, heading: string, options: Option[]) =>
    options.length > 0 ? (
      <div
        // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is a form grouping; inside a listbox the option group is role="group".
        role="group"
        aria-labelledby={headingId}
        className="navigator__options"
      >
        <div role="presentation" id={headingId} className="navigator__group">
          {heading}
        </div>
        {options.map(renderOption)}
      </div>
    ) : null;

  const listId = `${baseId}-list`;
  return (
    <div ref={scrimRef} className="navigator-scrim">
      <dialog open className="navigator" aria-modal="true" aria-label={t("shell.navigator.title")}>
        <div className="navigator__field">
          <Icon name="search" size="sm" className="navigator__search-icon" />
          <input
            ref={inputRef}
            className="navigator__input"
            type="text"
            role="combobox"
            aria-label={t("shell.navigator.input")}
            aria-expanded={shown.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("shell.navigator.open")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="navigator__kbd" dir="ltr">
            Esc
          </kbd>
        </div>
        <div
          id={listId}
          // biome-ignore lint/a11y/useSemanticElements: a native <select> cannot be the popup of a text combobox.
          role="listbox"
          // Focus stays in the combobox; the listbox is never a Tab stop.
          tabIndex={-1}
          aria-label={t("shell.navigator.title")}
          className="navigator__list"
        >
          {renderGroup(`${baseId}-pages`, t("shell.navigator.pages"), shownPages)}
          {renderGroup(`${baseId}-stores`, t("shell.navigator.stores"), shownStores)}
        </div>
        {stores.loading ? <p className="navigator__note">{t("shell.scope.loading")}</p> : null}
        {stores.failed ? (
          <div className="navigator__note navigator__failed">
            <span>{t("shell.scope.loadFailed")}</span>
            <button
              ref={retryRef}
              type="button"
              className="btn-ghost"
              onClick={stores.retry}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  inputRef.current?.focus();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
            >
              {t("common.tryAgain")}
            </button>
          </div>
        ) : null}
        <output className="navigator__note" aria-live="polite">
          {shown.length === 0 && !stores.loading && !stores.failed
            ? t("shell.navigator.empty", { query: query.trim() })
            : ""}
        </output>
      </dialog>
    </div>
  );
}

/** The trigger, the dialog while open, and the shortcut, for one shell. */
export function ShellNavigatorControl({
  navigator,
  groups,
  withStores,
}: Readonly<{
  navigator: ShellNavigator;
  groups: readonly NavGroup[];
  withStores: boolean;
}>): React.JSX.Element {
  return (
    <>
      <NavigatorTrigger navigator={navigator} />
      {navigator.open ? (
        <NavigatorDialog groups={groups} withStores={withStores} onClose={navigator.close} />
      ) : null}
    </>
  );
}
