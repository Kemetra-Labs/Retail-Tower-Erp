/**
 * RT-1540 — canonical hashing for the pinned `msx-eval/1` dataset.
 *
 * The hash is over canonical JSON of parsed values (keys sorted by code unit via
 * the repo serializer), never over raw file bytes, so a line-ending conversion
 * on a Windows checkout cannot change it.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../../../src/common/hashing/canonical-json";
import { MSX_CASES } from "./msx.cases";
import { MSX_DATASET_VERSION } from "./msx.types";

export function sha256Of(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The dataset: every case, its request, evidence fixture, expected outcome and gates. */
export function datasetHash(): string {
  return sha256Of({ version: MSX_DATASET_VERSION, cases: MSX_CASES });
}
