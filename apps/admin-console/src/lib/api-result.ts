/**
 * The `{ status, data?, error?, retryAfter? }` result every typed wrapper over the generated
 * `apiClient` returns (RT-1312): the HTTP status, the body or the error body, and the `Retry-After`
 * seconds of a 429 via the shared RT-621 classifier (30 s fallback, [1, 3600]). Used by the
 * wrappers added from RT-1312 on; the older wrappers keep their own copies.
 */
import { classifyRateLimit } from "@/lib/rate-limit";

export function resultOf<D, E>({
  data,
  error,
  response,
}: {
  data?: D;
  error?: E;
  response: Response;
}) {
  const { status } = response;
  const wait = classifyRateLimit({ status, retryAfter: response.headers.get("Retry-After") });
  return { status, data, error, retryAfter: wait?.retryAfterSeconds };
}
