### Removed
- RT-157: the idempotency interceptor no longer probes the pre-RT-155 template-only
  key (RT-82 K2). A new-key miss on a param route now goes straight to the claim and
  the handler, without the extra store lookup. Per-resource keys (K1) and
  non-replayable routes (K3) are unchanged. Every environment has run RT-155 for well
  over the 72h replay TTL.
