/**
 * POS pilot release resolver — RT-1292. Increments once per resolver call that
 * reaches the lane: `outcome` is the closed set {issued, none_not_configured,
 * none_not_allowlisted, none_no_current_release, none_class_mismatch,
 * none_pin_mismatch}. The caller never learns the reason of a `none_*`; it
 * lives here only. NEVER a version, tenant, user or release label: those are on
 * the registry, the allowlist and the audit log, and are a cardinality + §XIV
 * hazard.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  pos_pilot_release_resolve_total: ["outcome"],
};
