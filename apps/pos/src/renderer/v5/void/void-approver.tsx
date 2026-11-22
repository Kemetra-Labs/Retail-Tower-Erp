import { useEffect, useState, type JSX } from 'react';

import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import type { ManagerActionKind } from '../../../shared/operator/manager-action-kinds';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidAlert } from './void-parts';
import './void.css';

/**
 * The manager choice both void dialogs share (the void itself, and RT-1403 S2's cash exception):
 * the managers enrolled on this terminal who may approve an action kind, as opaque handles.
 */
export type Approvers =
  | { kind: 'loading' }
  | { kind: 'ready'; approvers: ManagerApprover[] }
  | { kind: 'refused'; message: string };

export function useApprovers(bridges: VoidBridges, actionKind: ManagerActionKind): Approvers {
  const [state, setState] = useState<Approvers>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const settle = (next: Approvers): void => {
      if (live) setState(next);
    };
    bridges.approval.listApprovers({ action_kind: actionKind }).then(
      (answer) => {
        settle(
          answer.kind === 'approvers'
            ? { kind: 'ready', approvers: answer.approvers }
            : { kind: 'refused', message: voidRefusalMessage(answer.reason) },
        );
      },
      () => {
        settle({ kind: 'refused', message: VOID_COPY.unavailable });
      },
    );
    return () => {
      live = false;
    };
  }, [bridges, actionKind]);
  return state;
}

export function ManagerChoice(props: {
  approvers: Approvers;
  name: string;
  selected: string | null;
  onSelect: (ref: string) => void;
}): JSX.Element {
  const { approvers } = props;
  if (approvers.kind === 'loading') return <output>{VOID_COPY.loading}</output>;
  if (approvers.kind === 'refused') return <VoidAlert message={approvers.message} />;
  if (approvers.approvers.length === 0) return <p>{VOID_COPY.noManagers}</p>;
  return (
    <fieldset className="v5-void-choices">
      <legend>{VOID_COPY.managerLegend}</legend>
      {approvers.approvers.map((manager) => (
        <label key={manager.approver_ref} className="v5-void-choice">
          <input
            type="radio"
            name={props.name}
            checked={props.selected === manager.approver_ref}
            onChange={() => {
              props.onSelect(manager.approver_ref);
            }}
          />
          <bdi>{manager.display_name}</bdi>
        </label>
      ))}
    </fieldset>
  );
}
