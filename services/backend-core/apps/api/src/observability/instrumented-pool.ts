/**
 * InstrumentedPool — pg.Pool subclass that emits `db_slow_query_total`
 * for every query whose wall-clock duration exceeds `SLOW_QUERY_THRESHOLD_SECONDS`.
 *
 * The instrumentation (RT-1211) lives in `@data-pulse-2/shared`
 * (`withSlowQueryRecorder`), shared with the worker; this app injects its own
 * recorder, so the counter is registered on the API's OTel meter (scope `db`,
 * port 9464). See the shared module for the design notes (callback-form
 * passthrough, SHA-256 `query_class`, the 500 ms threshold).
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { Logger } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";

import {
  SLOW_QUERY_THRESHOLD_SECONDS,
  hashQueryTemplate,
  onIdleClientError,
  withSlowQueryRecorder,
} from "@data-pulse-2/shared";

import { recordDbSlowQuery } from "./metrics/db.metrics";

export { SLOW_QUERY_THRESHOLD_SECONDS, hashQueryTemplate };

const logger = new Logger("db.pool");

/** `pg.Pool` whose Promise-form `query()` reports slow queries on the API's meter.
 *
 * RT-1246: an idle connection that Postgres terminates (e.g. 57P01 on a
 * restart) is logged and dropped instead of crashing the process.
 */
export class InstrumentedPool extends withSlowQueryRecorder(Pool, recordDbSlowQuery) {
  constructor(config?: PoolConfig) {
    super(config);
    onIdleClientError(this, (message) => logger.warn(message));
  }
}
