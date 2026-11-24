import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import type { ListBranchRosterResponse } from '../../../shared/bridge-api';
import type { ManagerApprovalBridgeAPI } from '../../../shared/operator/manager-approval';
import {
  RECOVERY_BATCH_MAX,
  type RecoveryBridgeAPI,
  type RecoveryHeldCartView,
  type RecoveryListHeldResponse,
  type RecoveryStuckAttemptView,
} from '../../../shared/operator/recovery';
import { formatHumanDateTime } from '../../ui/format/human-format';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Notice } from '../foundation/Notice';
import { ScreenSection } from '../foundation/ScreenSection';
import { Icon } from '../../icons/Icon';
import { RECOVERY_COPY, recoveryRefusalMessage } from './recovery-copy';
import { RecoveryActionDialog, type RecoveryAction } from './RecoveryActionDialog';
import { RECOVERY_ACTION_KIND } from './recovery-actions';
import { RecoveryAlert } from './RecoveryAlert';
import '../foundation/ledger.css';
import './recovery.css';

/**
 * RT-441 (RT-116 §5) — Manager → المبيعات المعلقة, `/app/manager/recovery`.
 *
 * Lists what other operators left on this terminal — the stuck payment and
 * the held sales — as TOTALS ONLY (no line items, no park label), and offers
 * the manager's three actions, each confirmed with the manager's own PIN
 * (an RT-114 approval, consumed by the action in main). Names come from the
 * branch roster; an operator the roster does not know shows as «موظف آخر».
 *
 * A session admitted in recovery mode lands here and can do nothing else
 * until the stuck payment is completed or cancelled; main then signs it out.
 *
 * RT-656 — drawn on the G-6 page header (ScreenSection) and V5 controls, as
 * the owner-approved references in docs/design/vnext/visual-acceptance/RC-Recovery.
 */

export interface RecoveryBridges {
  recovery: RecoveryBridgeAPI;
  approval: ManagerApprovalBridgeAPI;
  listRoster?: () => Promise<ListBranchRosterResponse>;
}

export function windowRecoveryBridges(): RecoveryBridges | null {
  const api = (
    window as unknown as {
      api?: {
        recovery?: RecoveryBridgeAPI;
        approval?: ManagerApprovalBridgeAPI;
        operator?: { listBranchRoster?: () => Promise<ListBranchRosterResponse> };
      };
    }
  ).api;
  if (api?.recovery === undefined || api.approval === undefined) return null;
  const listRoster = api.operator?.listBranchRoster;
  return {
    recovery: api.recovery,
    approval: api.approval,
    ...(listRoster === undefined ? {} : { listRoster: () => listRoster() }),
  };
}

type Held = { kind: 'loading' } | RecoveryListHeldResponse;

function useHeld(bridge: RecoveryBridgeAPI): { held: Held; reload: () => void } {
  const [held, setHeld] = useState<Held>({ kind: 'loading' });
  const ticket = useRef(0);
  const reload = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    bridge.listHeld().then(
      (answer) => {
        if (mine === ticket.current) setHeld(answer);
      },
      () => {
        if (mine === ticket.current) setHeld({ kind: 'refused', reason: 'recovery_unavailable' });
      },
    );
  }, [bridge]);
  useEffect(reload, [reload]);
  return { held, reload };
}

function useRosterNames(list: RecoveryBridges['listRoster']): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (list === undefined) return;
    let live = true;
    list().then(
      (answer) => {
        if (!live || answer.kind !== 'roster') return;
        setNames(new Map(answer.cashiers.map((c) => [c.id, c.display_name])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [list]);
  return names;
}

/**
 * RT-846 — can this manager confirm «إلغاء البيع»? Only a positive "no approver"
 * answer means no PIN; a refused or failed read is not that, and the dialog
 * already names its own reason, so the button stays offered then.
 */
function useCanCancelSale(approval: ManagerApprovalBridgeAPI): 'loading' | 'yes' | 'no_pin' {
  const [state, setState] = useState<'loading' | 'yes' | 'no_pin'>('loading');
  useEffect(() => {
    let live = true;
    approval.listApprovers({ action_kind: RECOVERY_ACTION_KIND.cancel_cart }).then(
      (answer) => {
        if (live)
          setState(answer.kind === 'approvers' && answer.approvers.length === 0 ? 'no_pin' : 'yes');
      },
      () => {
        if (live) setState('yes');
      },
    );
    return () => {
      live = false;
    };
  }, [approval]);
  return state;
}

/**
 * RT-1563 — a manager cancels several PARKED sales with one confirmation. Which sales are ticked is
 * screen state; WHAT a PIN covers is not: `cancelSelected` asks main for a snapshot (the prepare
 * step) and the approval is bound to that snapshot, not to this selection. Nothing is selected by
 * default, and a reload drops ticks for sales that are no longer listed.
 */
export interface BulkCancel {
  /** The parked drafts that can join a bulk cancel, in list order. */
  selectable: string[];
  selected: ReadonlySet<string>;
  preparing: boolean;
  error: string | null;
  toggle: (cart_id: string) => void;
  toggleAll: () => void;
  cancelSelected: () => void;
  clear: () => void;
}

function useBulkCancel(
  bridge: RecoveryBridgeAPI,
  held: Held,
  reload: () => void,
  open: (action: RecoveryAction) => void,
): BulkCancel {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectable =
    held.kind === 'held'
      ? held.held.filter((c) => c.parked && c.kind === 'draft').map((c) => c.cart_id)
      : [];
  const selected = new Set(selectable.filter((id) => picked.has(id)));
  const cap = Math.min(selectable.length, RECOVERY_BATCH_MAX);

  const cancelSelected = (): void => {
    setError(null);
    setPreparing(true);
    bridge.prepareCancelHeldCarts({ cart_ids: [...selected] }).then(
      (answer) => {
        setPreparing(false);
        if (answer.kind === 'prepared') {
          open({
            kind: 'cancel_parked_batch',
            batch: {
              batch_id: answer.batch_id,
              count: answer.count,
              total_minor: answer.total_minor,
              excluded: answer.excluded_cart_ids.length,
            },
          });
          return;
        }
        setError(
          answer.reason === 'not_found'
            ? RECOVERY_COPY.batchNoneEligible
            : recoveryRefusalMessage(answer.reason),
        );
        reload();
      },
      () => {
        setPreparing(false);
        setError(RECOVERY_COPY.unavailable);
      },
    );
  };

  return {
    selectable,
    selected,
    preparing,
    error,
    toggle: (cart_id) => {
      setPicked((now) => {
        const next = new Set(now);
        if (!next.delete(cart_id)) next.add(cart_id);
        return next;
      });
    },
    // One batch holds at most RECOVERY_BATCH_MAX sales; the rest stay listed for the next round.
    toggleAll: () => {
      setPicked(
        selected.size === cap ? new Set() : new Set(selectable.slice(0, RECOVERY_BATCH_MAX)),
      );
    },
    cancelSelected,
    clear: () => {
      setPicked(new Set());
    },
  };
}

export function RecoveryScreen({ bridges }: Readonly<{ bridges: RecoveryBridges }>): JSX.Element {
  const { held, reload } = useHeld(bridges.recovery);
  const canCancelSale = useCanCancelSale(bridges.approval);
  const names = useRosterNames(bridges.listRoster);
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const bulk = useBulkCancel(bridges.recovery, held, reload, (next) => {
    setOutcome(null);
    setAction(next);
  });
  const nameOf = (id: string): string => names.get(id) ?? RECOVERY_COPY.someoneElse;

  const open = (next: RecoveryAction): void => {
    setOutcome(null);
    setAction(next);
  };

  return (
    <ScreenSection title={RECOVERY_COPY.title}>
      <div className="v5-recovery" dir="rtl" lang="ar">
        {outcome !== null && (
          <Notice tone="success">
            <Outcome message={outcome} />
          </Notice>
        )}
        <HeldBody
          held={held}
          nameOf={nameOf}
          onAction={open}
          canCancelSale={canCancelSale}
          bulk={bulk}
        />
      </div>
      {action !== null && (
        <RecoveryActionDialog
          action={action}
          bridges={bridges}
          onDismiss={() => {
            setAction(null);
            // A bulk approval may have been spent on a snapshot that went stale: show the list as it is.
            if (action.kind === 'cancel_parked_batch') reload();
          }}
          onDone={(message) => {
            setAction(null);
            setOutcome(message);
            bulk.clear();
            reload();
          }}
        />
      )}
    </ScreenSection>
  );
}

function HeldBody(
  props: Readonly<{
    held: Held;
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
    canCancelSale: 'loading' | 'yes' | 'no_pin';
    bulk: BulkCancel;
  }>,
): JSX.Element {
  const { held } = props;
  if (held.kind === 'loading') {
    return (
      <div className="v5-recovery-state v5-recovery-neutral" aria-busy="true">
        <Notice tone="info">{RECOVERY_COPY.loading}</Notice>
      </div>
    );
  }
  if (held.kind === 'refused') {
    return (
      <div className="v5-recovery-state">
        <RecoveryAlert message={recoveryRefusalMessage(held.reason)} />
      </div>
    );
  }
  return (
    <>
      {held.recovery_mode && (
        <div className="v5-recovery-neutral" role="note">
          <Notice tone="info" announce={false}>
            {RECOVERY_COPY.recoveryMode}
          </Notice>
        </div>
      )}
      <div className="v5-recovery-grid">
        <StuckPanel stuck={held.stuck} nameOf={props.nameOf} onAction={props.onAction} />
        <HeldPanel
          held={held.held}
          nameOf={props.nameOf}
          onAction={props.onAction}
          canCancelSale={props.canCancelSale}
          bulk={props.bulk}
        />
      </div>
    </>
  );
}

/** An amount or a count: Western digits, LTR, tabular (DESIGN.md OD-3). */
function Num({ children }: Readonly<{ children: string | number }>): JSX.Element {
  return <bdi className="v5-recovery-money">{children}</bdi>;
}

/** formatCheckoutMoney's output inside a sentence: «1,250.00 EGP», «−5.00 EGP». */
const MONEY_RUN = /\u2212?[\d,]+\.\d{2} EGP/;

/** An outcome sentence with its amount isolated, so bidi never reads «EGP 50.00». */
function Outcome({ message }: Readonly<{ message: string }>): JSX.Element {
  const run = MONEY_RUN.exec(message);
  if (run === null) return <>{message}</>;
  const end = run.index + run[0].length;
  return (
    <>
      {message.slice(0, run.index)}
      <Num>{run[0]}</Num>
      {message.slice(end)}
    </>
  );
}

/**
 * One ledger row (RT-1026, the shared `.v5-ledger-row`); `text` sets a word (a
 * name) in the body face, not the tabular one; `total` anchors the last row.
 */
function Fact(
  props: Readonly<{ label: string; value: string; text?: boolean; total?: boolean }>,
): JSX.Element {
  const { label, value } = props;
  return (
    <div className={props.total === true ? 'v5-ledger-row v5-ledger-row--total' : 'v5-ledger-row'}>
      <dt>{label}</dt>
      <dd className={props.text === true ? 'v5-recovery-text' : 'v5-ledger-row__amount'}>
        {props.text === true ? <bdi>{value}</bdi> : <Num>{value}</Num>}
      </dd>
    </div>
  );
}

/**
 * An absolute, machine-readable time in Western digits; nothing at all when it cannot be read.
 * Not `Num`: that is LTR, and «13 أكتوبر، 12:00» mixes Arabic words with digits, so it keeps
 * the page direction and reads right-to-left.
 */
function Stamp({ iso }: Readonly<{ iso: string }>): JSX.Element | null {
  const text = formatHumanDateTime(iso, { withYear: true });
  if (text === null) return null;
  return (
    <time dateTime={iso} className="v5-recovery-time">
      {text}
    </time>
  );
}

function Panel(
  props: Readonly<{
    id: string;
    title: string;
    icon: 'cash' | 'held';
    className?: string;
    children: ReactNode;
  }>,
): JSX.Element {
  const cls = props.className === undefined ? '' : ` ${props.className}`;
  return (
    <section className={`v5-recovery-panel${cls}`} aria-labelledby={props.id}>
      <header className="v5-recovery-panel-head">
        <span className="v5-recovery-glyph">
          <Icon name={props.icon} />
        </span>
        <h2 id={props.id}>{props.title}</h2>
      </header>
      {props.children}
    </section>
  );
}

function Empty({ text }: Readonly<{ text: string }>): JSX.Element {
  return (
    <div className="v5-recovery-panel-body">
      <p className="v5-recovery-empty">
        <Icon name="status.neutral" />
        {text}
      </p>
    </div>
  );
}

function Initial({ name }: Readonly<{ name: string }>): JSX.Element {
  return (
    <span className="v5-recovery-initial" aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}

function StuckPanel(
  props: Readonly<{
    stuck: RecoveryStuckAttemptView | null;
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
  }>,
): JSX.Element {
  const { stuck } = props;
  return (
    <Panel
      id="recovery-stuck"
      title={RECOVERY_COPY.stuckTitle}
      icon="cash"
      className="v5-recovery-panel--stuck"
    >
      {stuck === null ? (
        <Empty text={RECOVERY_COPY.noneStuck} />
      ) : (
        <div className="v5-recovery-panel-body">
          <StuckFacts stuck={stuck} owner={props.nameOf(stuck.owning_operator_id)} />
          <div className="v5-recovery-actions">
            <button
              type="button"
              className="v5-recovery-btn v5-recovery-btn--primary v5-btn v5-btn--primary"
              onClick={() => {
                props.onAction({ kind: 'complete', stuck });
              }}
            >
              {RECOVERY_COPY.complete}
            </button>
            <button
              type="button"
              className="v5-recovery-btn v5-btn"
              onClick={() => {
                props.onAction({ kind: 'cancel_attempt', stuck });
              }}
            >
              {RECOVERY_COPY.cancelPayment}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Totals and live tender only: a zero tender line is never shown. */
function StuckFacts(
  props: Readonly<{ stuck: RecoveryStuckAttemptView; owner: string }>,
): JSX.Element {
  const { stuck } = props;
  return (
    <dl className="v5-recovery-ledger">
      <Fact label={RECOVERY_COPY.owner} value={props.owner} text />
      <StartedFact iso={stuck.started_at} />
      <Fact label={RECOVERY_COPY.lines} value={String(stuck.line_count)} />
      <Fact label={RECOVERY_COPY.total} value={formatCheckoutMoney(stuck.total_minor)} />
      {stuck.cash_minor > 0 && (
        <Fact label={RECOVERY_COPY.cash} value={formatCheckoutMoney(stuck.cash_minor)} />
      )}
      {stuck.card_minor > 0 && (
        <Fact label={RECOVERY_COPY.card} value={formatCheckoutMoney(stuck.card_minor)} />
      )}
      {stuck.voucher_minor > 0 && (
        <Fact label={RECOVERY_COPY.voucher} value={formatCheckoutMoney(stuck.voucher_minor)} />
      )}
      <Fact
        label={RECOVERY_COPY.remaining}
        value={formatCheckoutMoney(stuck.remaining_minor)}
        total
      />
    </dl>
  );
}

/** RT-1190: when the stuck payment began, so a manager can tell how stale it is. */
function StartedFact({ iso }: Readonly<{ iso: string }>): JSX.Element | null {
  if (formatHumanDateTime(iso, { withYear: true }) === null) return null;
  return (
    <div className="v5-ledger-row">
      <dt>{RECOVERY_COPY.startedAt}</dt>
      <dd className="v5-ledger-row__amount">
        <Stamp iso={iso} />
      </dd>
    </div>
  );
}

function HeldPanel(
  props: Readonly<{
    held: RecoveryHeldCartView[];
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
    canCancelSale: 'loading' | 'yes' | 'no_pin';
    bulk: BulkCancel;
  }>,
): JSX.Element {
  const { bulk } = props;
  // Two or more parked drafts, and a PIN to confirm with: a single one keeps its own button.
  const bulkOn = bulk.selectable.length >= 2 && props.canCancelSale !== 'no_pin';
  return (
    <Panel id="recovery-held" title={RECOVERY_COPY.heldTitle} icon="held">
      {props.held.length === 0 ? (
        <Empty text={RECOVERY_COPY.noneHeld} />
      ) : (
        <>
          {props.canCancelSale === 'no_pin' && (
            <div className="v5-recovery-neutral">
              <Notice tone="info">{RECOVERY_COPY.cancelSaleNoPin}</Notice>
            </div>
          )}
          {bulkOn && <BulkBar bulk={bulk} />}
          <ul className={bulkOn ? 'v5-recovery-rows v5-recovery-rows--select' : 'v5-recovery-rows'}>
            {props.held.map((cart) => {
              const owner = cart.own ? RECOVERY_COPY.you : props.nameOf(cart.owning_operator_id);
              return (
                <HeldRow
                  key={cart.cart_id}
                  cart={cart}
                  owner={owner}
                  onAction={props.onAction}
                  canCancel={props.canCancelSale !== 'no_pin'}
                  pick={
                    bulkOn && bulk.selectable.includes(cart.cart_id)
                      ? {
                          checked: bulk.selected.has(cart.cart_id),
                          onChange: () => {
                            bulk.toggle(cart.cart_id);
                          },
                        }
                      : bulkOn
                        ? 'reserve'
                        : null
                  }
                />
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** RT-1563: select all, the count, and the one bulk action. The consequence is stated in the dialog. */
function BulkBar({ bulk }: Readonly<{ bulk: BulkCancel }>): JSX.Element {
  const cap = Math.min(bulk.selectable.length, RECOVERY_BATCH_MAX);
  const all = bulk.selected.size === cap;
  return (
    <div className="v5-recovery-bulk">
      <label className="v5-recovery-choice">
        <input type="checkbox" checked={all} onChange={bulk.toggleAll} />
        <span>{RECOVERY_COPY.selectAllParked}</span>
      </label>
      <span className="v5-recovery-meta">
        {RECOVERY_COPY.selectedLabel}: <Num>{bulk.selected.size}</Num>
      </span>
      <button
        type="button"
        className="v5-recovery-btn v5-btn v5-btn--danger"
        disabled={bulk.selected.size === 0 || bulk.preparing}
        onClick={bulk.cancelSelected}
      >
        {RECOVERY_COPY.cancelSelected}
      </button>
      <RecoveryAlert message={bulk.error} />
    </div>
  );
}

function HeldRow(
  props: Readonly<{
    cart: RecoveryHeldCartView;
    owner: string;
    onAction: (action: RecoveryAction) => void;
    canCancel: boolean;
    /** A tick box for a parked draft; 'reserve' keeps the column on a row that has none. */
    pick: { checked: boolean; onChange: () => void } | 'reserve' | null;
  }>,
): JSX.Element {
  const { cart } = props;
  return (
    <li className="v5-recovery-row">
      {props.pick === 'reserve' && <span aria-hidden="true" />}
      {props.pick !== null && props.pick !== 'reserve' && (
        <input
          type="checkbox"
          className="v5-recovery-check"
          checked={props.pick.checked}
          onChange={props.pick.onChange}
          aria-label={`${RECOVERY_COPY.selectRow}: ${props.owner}`}
        />
      )}
      <Initial name={props.owner} />
      <div className="v5-recovery-row__who">
        <span className="v5-recovery-name">
          <bdi>{props.owner}</bdi>
        </span>
        <span className="v5-recovery-tags">
          <span className="v5-recovery-tag">
            {cart.kind === 'draft' ? RECOVERY_COPY.draft : RECOVERY_COPY.handedOff}
          </span>
        </span>
        <span className="v5-recovery-meta">
          <Stamp iso={cart.updated_at} />
          {cart.parked && <span>{RECOVERY_COPY.parked}</span>}
        </span>
      </div>
      <div className="v5-recovery-row__sum">
        <Num>{formatCheckoutMoney(cart.total_minor)}</Num>
        <span>
          {RECOVERY_COPY.lines} <Num>{cart.line_count}</Num>
        </span>
      </div>
      {props.canCancel && (
        <button
          type="button"
          className="v5-recovery-btn v5-btn"
          onClick={() => {
            props.onAction({ kind: 'cancel_cart', cart });
          }}
        >
          {RECOVERY_COPY.cancelSale}
        </button>
      )}
    </li>
  );
}
