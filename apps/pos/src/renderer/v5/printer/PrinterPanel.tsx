import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type {
  InstalledPrinter,
  PrinterBridgeAPI,
  PrinterChoice,
  PrinterTestPrintResponse,
} from '../../../shared/printer/types';
import { Dialog } from '../foundation/Dialog';
import { Notice } from '../foundation/Notice';
import {
  PRINTER_COPY,
  printerLabel,
  refusalMessage,
  testAcceptedMessage,
  testFailedMessage,
  testMissingMessage,
} from './printer-copy';
import {
  acceptPrinterChoice,
  closePrinterPanel,
  printerBridge,
  printerChoiceGeneration,
  usePrinterStore,
} from './printer-store';
import './printer.css';

const OS_DEFAULT_KEY = 'os_default';

/** One radio value per choice; a printer key can never equal the default's. */
function keyOf(choice: PrinterChoice | null): string | null {
  if (choice === null) return null;
  return choice.source === 'os_default' ? OS_DEFAULT_KEY : `printer:${choice.printer_name}`;
}

function choiceOf(key: string): PrinterChoice {
  return key === OS_DEFAULT_KEY
    ? { source: 'os_default' }
    : { source: 'chosen', printer_name: key.slice('printer:'.length) };
}

type PrinterList =
  | { kind: 'loading' }
  | { kind: 'ready'; printers: InstalledPrinter[] }
  | { kind: 'refused'; message: string };

type Message = { tone: 'info' | 'success' | 'warning'; text: string };

function usePrinterList(bridge: PrinterBridgeAPI | undefined): PrinterList {
  const [list, setList] = useState<PrinterList>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const settle = (next: PrinterList): void => {
      if (live) setList(next);
    };
    if (bridge === undefined) {
      settle({ kind: 'refused', message: refusalMessage('bridge_failed') });
      return;
    }
    bridge.list().then(
      (answer) => {
        settle(
          answer.kind === 'ok'
            ? { kind: 'ready', printers: answer.printers }
            : { kind: 'refused', message: refusalMessage(answer.reason) },
        );
      },
      () => {
        settle({ kind: 'refused', message: refusalMessage('bridge_failed') });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  return list;
}

/** A test page outcome as one honest sentence. */
function testMessage(answer: PrinterTestPrintResponse): Message {
  if (answer.kind === 'refused') return { tone: 'warning', text: refusalMessage(answer.reason) };
  const label = printerLabel(answer.choice);
  if (answer.kind === 'accepted') return { tone: 'info', text: testAcceptedMessage(label) };
  return {
    tone: 'warning',
    text:
      answer.reason === 'printer_missing' ? testMissingMessage(label) : testFailedMessage(label),
  };
}

function PrinterOptions(props: {
  list: PrinterList;
  name: string;
  selected: string | null;
  disabled: boolean;
  onSelect: (key: string) => void;
}): JSX.Element {
  const { list } = props;
  const option = (key: string, label: JSX.Element): JSX.Element => (
    <label key={key} className="v5-printer-choice">
      <input
        type="radio"
        name={props.name}
        checked={props.selected === key}
        disabled={props.disabled}
        onChange={() => {
          props.onSelect(key);
        }}
      />
      {label}
    </label>
  );
  return (
    <fieldset className="v5-printer-choices">
      <legend>{PRINTER_COPY.listLegend}</legend>
      {option(
        OS_DEFAULT_KEY,
        <span className="v5-printer-choice__text">
          <span>{PRINTER_COPY.osDefault}</span>
          <span className="v5-printer-choice__hint">{PRINTER_COPY.osDefaultHint}</span>
        </span>,
      )}
      {list.kind === 'loading' && <output>{PRINTER_COPY.loading}</output>}
      {list.kind === 'refused' && <Notice tone="warning">{list.message}</Notice>}
      {list.kind === 'ready' && list.printers.length === 0 && <p>{PRINTER_COPY.noPrinters}</p>}
      {list.kind === 'ready' &&
        list.printers.map((p) =>
          option(
            `printer:${p.name}`,
            <bdi className="v5-printer-choice__text" dir="ltr">
              {p.name}
            </bdi>,
          ),
        )}
    </fieldset>
  );
}

interface PrinterPanelProps {
  /** Injected for tests; production uses `window.api.printer`. */
  bridge?: PrinterBridgeAPI | undefined;
  onClose: () => void;
}

/**
 * RT-886 (RT-839 D4/D5) — the «الطابعة» panel: the installed printers plus
 * «Windows default», a save, and a test page. Any signed-in role reaches it
 * (footer row, banner shortcut, Sale prompt); main checks the session.
 *
 * A test page goes to the SAVED printer, so an unsaved pick is saved first.
 * Its success only says Windows accepted the job and asks the operator to look
 * at the printer: the OS print path cannot see paper. Focus opens on «إغلاق»
 * (the safe control); Esc closes unless a call is running.
 */
export function PrinterPanel({
  bridge = printerBridge(),
  onClose,
}: PrinterPanelProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const groupName = useId();
  const introId = useId();
  const saved = usePrinterStore((s) => s.choice);
  const list = usePrinterList(bridge);
  const [selected, setSelected] = useState<string | null>(keyOf(saved));
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const dirty = selected !== null && selected !== keyOf(saved);

  /** Save the pick; true when main saved it (or nothing needed saving). */
  const save = async (): Promise<boolean> => {
    if (bridge === undefined || selected === null) return false;
    if (!dirty) return true;
    const asked = printerChoiceGeneration();
    const answer = await bridge.set({ choice: choiceOf(selected) });
    if (answer.kind !== 'ok') {
      setMessage({ tone: 'warning', text: refusalMessage(answer.reason) });
      return false;
    }
    // A save answered after the session changed must not repopulate the next session's view.
    return acceptPrinterChoice(answer.choice, asked);
  };

  const run = (kind: 'save' | 'test', task: () => Promise<void>): void => {
    if (busy !== null) return;
    setBusy(kind);
    setMessage(null);
    task()
      .catch(() => {
        setMessage({ tone: 'warning', text: refusalMessage('bridge_failed') });
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const onSave = (): void => {
    run('save', async () => {
      if (await save()) setMessage({ tone: 'success', text: PRINTER_COPY.saved });
    });
  };

  const onTest = (): void => {
    run('test', async () => {
      if (bridge === undefined || !(await save())) return;
      setMessage(testMessage(await bridge.testPrint()));
    });
  };

  return (
    <Dialog
      label={PRINTER_COPY.panelTitle}
      initialFocusRef={closeRef}
      describedBy={introId}
      {...(busy === null ? { onCancel: onClose } : {})}
    >
      <h2 className="v5-printer-title">{PRINTER_COPY.panelTitle}</h2>
      <p id={introId}>{PRINTER_COPY.intro}</p>
      <PrinterOptions
        list={list}
        name={groupName}
        selected={selected}
        disabled={busy !== null}
        onSelect={setSelected}
      />
      <div className="v5-printer-slot" role="status" aria-live="polite">
        {message !== null && (
          <Notice tone={message.tone} announce={false}>
            {message.text}
          </Notice>
        )}
      </div>
      <div className="v5-printer-actions">
        <button
          ref={closeRef}
          type="button"
          className="v5-btn"
          disabled={busy !== null}
          onClick={onClose}
        >
          {PRINTER_COPY.close}
        </button>
        <button
          type="button"
          className="v5-btn"
          disabled={busy !== null || selected === null || bridge === undefined}
          aria-busy={busy === 'test' ? 'true' : undefined}
          onClick={onTest}
        >
          {PRINTER_COPY.testPrint}
        </button>
        <button
          type="button"
          className="v5-btn v5-btn--primary"
          disabled={busy !== null || !dirty || bridge === undefined}
          aria-busy={busy === 'save' ? 'true' : undefined}
          onClick={onSave}
        >
          {PRINTER_COPY.save}
        </button>
      </div>
    </Dialog>
  );
}

/** The one panel instance, opened from the footer row, the banner or the prompt. */
export function PrinterPanelHost(): JSX.Element | null {
  const open = usePrinterStore((s) => s.panelOpen);
  return open ? <PrinterPanel onClose={closePrinterPanel} /> : null;
}
