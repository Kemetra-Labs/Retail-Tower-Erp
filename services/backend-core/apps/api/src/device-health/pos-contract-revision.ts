/**
 * `pos_contract_revision` (RT-327, AD-DEVICE-001 D-3): a single integer that
 * Backend-Core increments whenever it ships a POS-facing API change a POS
 * release may depend on. The POS CompatGate (RT-322) installs an update only
 * when its latest `HeartbeatAck` carries a revision at least the release's
 * `requires_pos_contract_revision`.
 *
 * RULES
 *   - It is a constant in the runtime, never configuration and never stored.
 *   - Increment it in the SAME pull request as the OpenAPI change that adds
 *     the capability (an additive POS-facing field, operation or header a
 *     release may rely on). It never decreases.
 *   - 1 is the first value: the revision that ships the heartbeat itself.
 *
 * HISTORY
 *   1  RT-327: the heartbeat itself.
 *   2  RT-1312 F1: the heartbeat accepts `sale_queue`. A POS sends it only
 *      once a reply carried revision 2 or more: an older Backend-Core refuses
 *      the unknown key with a 400.
 *   3  RT-1312 Phase 3: `posQuarantineSale` (`pos-sales/sale-quarantine.yaml`)
 *      is live, and the Console can show and close its queue. A till uploads
 *      a refused or held sale only once a reply carried revision 3 or more
 *      (POS `QUARANTINE_UPLOAD_MIN_REVISION`), because an uploaded row stops
 *      being counted in its heartbeat `sale_queue`. That contract leaves the
 *      number to the runtime ("Rollout order"), so this bump lands on its own,
 *      after the runtime (#508, #723) and the Console queue (#731).
 */
export const POS_CONTRACT_REVISION = 3;
