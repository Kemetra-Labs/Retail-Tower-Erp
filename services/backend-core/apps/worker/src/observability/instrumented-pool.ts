/**
 * InstrumentedPool — pg.Pool subclass that emits `db_slow_query_total`
 * for every query whose wall-clock duration exceeds `SLOW_QUERY_THRESHOLD_SECONDS`.
 *
 * The instrumentation (RT-1211) lives in `@data-pulse-2/shared`
 * (`withSlowQueryRecorder`), shared with the API; the worker injects its own
 * recorder from its own metrics module, so the counter is registered on the
 * worker's OTel Meter (port 9091) rather than the API's (port 9464). See the
 * shared module for the design notes (callback-form passthrough, SHA-256
 * `query_class`, the 500 ms threshold).
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { Pool } from "pg";

import {
  SLOW_QUERY_THRESHOLD_SECONDS,
  hashQueryTemplate,
  withSlowQueryRecorder,
} from "@data-pulse-2/shared";

import { recordDbSlowQuery } from "./metrics/worker.metrics";

export { SLOW_QUERY_THRESHOLD_SECONDS, hashQueryTemplate };

/** `pg.Pool` whose Promise-form `query()` reports slow queries on the worker's meter. */
export class InstrumentedPool extends withSlowQueryRecorder(Pool, recordDbSlowQuery) {}
