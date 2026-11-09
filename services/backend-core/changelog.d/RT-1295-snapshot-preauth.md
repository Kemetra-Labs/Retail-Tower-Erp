### Security
- RT-1295: a `binViewReportSnapshot` body above 100 kB (or chunked, or
  compressed) is now read only after its caller passes the route's own
  connector guards on the request headers (`ConnectorAuthGuard`, then
  `ConnectorEnvironmentGuard`). A caller with no, an invalid or a non-connector
  credential gets 401, and a connector of another environment 403, with
  `Connection: close` before any body byte is read, and never takes one of the
  2 large-body slots. Before this change an unauthenticated caller could hold
  both slots and block real connector snapshots with 503 `snapshot_busy`.
  Unchanged: the 32 MiB limit (every legal window with ASCII names, at most
  about 26.4 MiB) and its known gap: a window near the contract maximum with
  long Arabic names (about 93.8 MiB as the Connector escapes it) still fails
  closed with 413. No contract change: 401 and 403 were already listed.
