/**
 * RT-1539 — maps a Gateway result to the contract's 200 body (`answer | refusal | unavailable`), or to
 * the 404 / 500 it must be instead. Pure.
 *
 *   ok                                   -> the validated `answer`
 *   declined (a preflight refusal)       -> `refusal`, family `answer`
 *   fallback not_authorized / store_out_of_scope -> the non-disclosing 404 (never a 200 body)
 *   fallback in the contract's eleven    -> `unavailable`, family `gateway`, the reason used verbatim
 *   any other fallback                   -> a server fault (500): nothing in a tier-0 run can produce
 *                                           it but a defect, and the reservation is already released
 */
import type { AiGatewayResult } from "../gateway/ai-gateway.types";
import { MSX_REFUSAL_CODES, MSX_UNAVAILABLE_CODES, type MsxRefusalCode, type MsxUnavailableCode } from "./msx.constants";
import type { ManagerSalesAnswer } from "./msx.output";

export type ExplainBody =
  | ManagerSalesAnswer
  | { readonly kind: "refusal"; readonly family: "answer"; readonly code: MsxRefusalCode }
  | { readonly kind: "unavailable"; readonly family: "gateway"; readonly code: MsxUnavailableCode };

export type Mapped =
  | { readonly kind: "body"; readonly body: ExplainBody }
  | { readonly kind: "not_found" }
  | { readonly kind: "fault"; readonly reason: string };

const REFUSALS: ReadonlySet<string> = new Set(MSX_REFUSAL_CODES);
const UNAVAILABLE: ReadonlySet<string> = new Set(MSX_UNAVAILABLE_CODES);

export function mapResult(result: AiGatewayResult<ManagerSalesAnswer>): Mapped {
  switch (result.kind) {
    case "ok":
      return { kind: "body", body: result.output };
    case "declined":
      return REFUSALS.has(result.decline.code)
        ? { kind: "body", body: { kind: "refusal", family: "answer", code: result.decline.code as MsxRefusalCode } }
        : { kind: "fault", reason: "unknown_decline" };
    case "fallback":
      if (result.reason === "not_authorized" || result.reason === "store_out_of_scope") return { kind: "not_found" };
      return UNAVAILABLE.has(result.reason)
        ? { kind: "body", body: { kind: "unavailable", family: "gateway", code: result.reason as MsxUnavailableCode } }
        : { kind: "fault", reason: result.reason };
  }
}
