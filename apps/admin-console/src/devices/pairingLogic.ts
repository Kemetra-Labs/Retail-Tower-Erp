/**
 * RT-372 pure helpers for the pairing-code forms. No React, no fetch.
 *
 * The issue form collects the terminal binding the contract requires (decision
 * C1): the branch name and address and the tax registration id, which the POS
 * pins at pairing and prints on receipts. Backend-Core holds no other source
 * for them. These are form checks that mirror the contract's patterns; the
 * server re-validates everything. There is no time-to-live field (RT-1316): the
 * server's default applies to every code the console issues.
 */
import type { MessageKey } from "@/i18n";
import type { PairingCodeIssueRequest } from "@/lib/device-queries";

export interface IssueDraft {
  storeId: string;
  terminalLabel: string;
  branchName: string;
  branchAddress: string;
  taxRegistrationId: string;
}

export const EMPTY_ISSUE_DRAFT: IssueDraft = {
  storeId: "",
  terminalLabel: "",
  branchName: "",
  branchAddress: "",
  taxRegistrationId: "",
};

export interface FieldProblem {
  key: MessageKey;
  params?: { max: number };
}

export type IssueProblems = Partial<Record<keyof IssueDraft, FieldProblem>>;

const LIMITS = {
  terminalLabel: 64,
  branchName: 256,
  branchAddress: 512,
  taxRegistrationId: 64,
} as const;

function textProblem(value: string, max: number, required: boolean): FieldProblem | undefined {
  if (value.includes("\u0000")) return { key: "devices.text.invalid" };
  if (value.trim() === "") return required ? { key: "devices.text.required" } : undefined;
  return value.length > max ? { key: "devices.issue.problem.tooLong", params: { max } } : undefined;
}

/** The checks per field; a field with no entry has nothing to check. */
const CHECKS: Readonly<
  Partial<Record<keyof IssueDraft, (value: string) => FieldProblem | undefined>>
> = {
  storeId: (v) => (v === "" ? { key: "devices.text.required" } : undefined),
  branchName: (v) => textProblem(v, LIMITS.branchName, true),
  branchAddress: (v) => textProblem(v, LIMITS.branchAddress, true),
  taxRegistrationId: (v) => textProblem(v, LIMITS.taxRegistrationId, true),
  terminalLabel: (v) => textProblem(v, LIMITS.terminalLabel, false),
};

export function validateIssueDraft(draft: IssueDraft): IssueProblems {
  const problems: IssueProblems = {};
  for (const [field, check] of Object.entries(CHECKS)) {
    const problem = check(draft[field as keyof IssueDraft]);
    if (problem) problems[field as keyof IssueDraft] = problem;
  }
  return problems;
}

/**
 * The issue request. `replacesDeviceId` makes it a replace (the device's own
 * store) or a move (another store): the server derives which from the stores,
 * so no kind is sent.
 */
export function buildIssueBody(
  draft: IssueDraft,
  replacesDeviceId?: string,
): PairingCodeIssueRequest {
  const label = draft.terminalLabel.trim();
  return {
    storeId: draft.storeId,
    branchName: draft.branchName.trim(),
    branchAddress: draft.branchAddress.trim(),
    taxRegistrationId: draft.taxRegistrationId.trim(),
    ...(label === "" ? {} : { terminalLabel: label }),
    ...(replacesDeviceId ? { replacesDeviceId } : {}),
  };
}

/**
 * A client-generated opaque key (UUID v4: 36 printable characters, inside the
 * contract's 16..128). The issue is non-replayable (RT-82 K3): a key is never
 * reused, so every submit asks for a new one.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const GROUP = 4;

/**
 * The code as people read it: groups of four joined by "-" (RT-1316). Display
 * only: the contract calls the code opaque, so any length is grouped and nothing
 * is checked, and Copy and the barcode carry the code exactly as issued.
 */
export function groupPairingCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) groups.push(code.slice(i, i + GROUP));
  return groups.join("-");
}
