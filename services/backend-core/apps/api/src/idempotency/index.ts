/**
 * The `idempotency` module's port (RT-1453 module boundaries). Other modules import from here, not
 * from the files inside. It exposes only the route marker that engages the idempotency interceptor.
 */
export { Idempotent } from "./idempotent.decorator";
