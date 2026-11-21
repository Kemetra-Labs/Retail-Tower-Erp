/**
 * RT-1540 — validators built from the P-05 contract on `main` (RT-1538): the
 * request schema, the 200 response schema and the wire rules a JSON Schema
 * cannot express (the 31-day span). Reuses the repo's `ajv` and the contract
 * loader; no dependency is added.
 */
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { allContracts, contractDocument } from "../../../_helpers/openapi-contract";
import { MSX_VERSIONS } from "./msx.types";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const SCHEMA_ID = `urn:msx:${MSX_VERSIONS.contractId}`;

function validatorFor(schema: "ManagerSalesExplainRequest" | "ManagerSalesExplainResponse"): ValidateFunction {
  if (!ajv.getSchema(SCHEMA_ID)) {
    ajv.addSchema(contractDocument(allContracts(), MSX_VERSIONS.contractId) as object, SCHEMA_ID);
  }
  const found = ajv.getSchema(`${SCHEMA_ID}#/components/schemas/${schema}`);
  if (!found) throw new Error(`ajv cannot resolve ${MSX_VERSIONS.contractId}#${schema}`);
  return found;
}

export interface Verdict {
  readonly valid: boolean;
  readonly errors: string;
}

function verdictOf(validate: ValidateFunction, value: unknown): Verdict {
  const valid = validate(value) as boolean;
  return { valid, errors: valid ? "" : ajv.errorsText(validate.errors) };
}

export const validateRequest = (body: unknown): Verdict => verdictOf(validatorFor("ManagerSalesExplainRequest"), body);
export const validateResponse = (body: unknown): Verdict => verdictOf(validatorFor("ManagerSalesExplainResponse"), body);

const DAY_MS = 86_400_000;

/**
 * The rule the contract states in prose: `to >= from` and `to - from <= 30`
 * (at most 31 days). The server answers 400 `validation_error`; it never truncates.
 */
export function spanViolation(body: { readonly from?: unknown; readonly to?: unknown }): boolean {
  if (typeof body.from !== "string" || typeof body.to !== "string") return false;
  const days = (Date.parse(body.to) - Date.parse(body.from)) / DAY_MS;
  return days < 0 || days > 30;
}
