/**
 * The `console-rate-limit` module's port (RT-1453 module boundaries). Other modules import from
 * here, not from the files inside. It exposes only the per-route cost-class marker (RT-574 D3).
 */
export { ConsoleRateLimit } from "./console-rate-limit.decorator";
