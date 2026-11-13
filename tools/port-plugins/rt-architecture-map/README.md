# Retail Tower Architecture Map (Port plugin)

Live architecture map of POS, Admin-Console, Backend-Core, ERPNext-Connector and ERPNext, shown as a custom widget on the Port **Retail Tower Cockpit** dashboard.

It draws the fixed integration path from the architecture invariants (POS and Admin-Console call only Backend-Core; ERPNext-Connector is the only ERPNext adapter) and colours each service from live Port catalog data. It refreshes every 60 seconds.

## What each part means

| Element | Source in Port | Meaning |
|---|---|---|
| Card border, dot and shadow colour | `obs_monitors_not_ok`, `obs_unresolved_sentry_issues`, `obs_datadog_monitors`, `runtime` on the `service` entity | Checked in this order, first match wins. Red: a linked Datadog monitor is in Alert, Warn or No Data. Orange: unresolved staging Sentry issues. Grey: a server or web app with no Datadog monitor yet. Green: none of these |
| Level pill | `scorecards.observability_readiness.level` | The service's Observability Readiness (Staging) level |
| Numbers | `obs_unresolved_sentry_issues`, `obs_datadog_monitors`, `obs_monitors_not_ok`, `github_open_prs` | Open Sentry issues, linked monitors (and how many are down), open PRs |
| Moving dots | none (static) | Direction of data flow on the allowed paths |
| Red dotted lines | none (static) | Forbidden direct paths from POS and Admin-Console to ERPNext |

All signals are from the **staging lab**; nothing here is Production evidence.

## Prerequisites in the Port catalog

- Blueprint `service` with entities `pos`, `admin-console`, `backend-core` and `erpnext-connector`.
- On `service`: the `runtime` property, the aggregation properties `obs_datadog_monitors`, `obs_monitors_not_ok`, `obs_unresolved_sentry_issues`, and the scorecard `observability_readiness`.
- `github_open_prs` (existing aggregation on `service`).

A service missing from the catalog is drawn as "Not in the Port catalog" instead of breaking the map.

## Plugin parameters

None. The widget reads the catalog through the Port API with the viewer's own session token.

## Implementation notes

- One self-contained HTML file: no build step, no npm dependencies, no external scripts or fonts.
- Uses the Port iframe bridge directly: sends `REQUEST_PORT_TOKEN`, reads `PORT_TOKEN` and `PLUGIN_DATA` (`baseUrl`, `theme.css`), then calls `POST /v1/blueprints/service/entities/search`.
- Builds the SVG with `createElementNS` and `textContent` only; no `innerHTML`.
- Accepts bridge messages only from the parent window, and a `baseUrl` only when it is an https `port.io` or `getport.io` host, so the token is never sent elsewhere.
- On a 401 it asks for a new token once per refresh cycle. On any error it keeps the last map and shows the error in the bar.
- Redraws only when the data changed, so keyboard focus and animations survive the 60-second refresh.
- Each service card is a link with a spoken label (status and counts); status is never shown by colour alone.
- Respects `prefers-reduced-motion` (packets and pulses are hidden).
- Node positions are fixed in the file. A new service needs a new entry in `NODES` and a route in `ROUTES`.

## Upload

The plugin identifier in Port is `rt-architecture-map`. To update it, upload this file's content with the Port MCP `upsert_plugin` tool (inline `html`, since the remote MCP cannot read local paths) or with the CLI:

```bash
npx @port-labs/port-plugins-cli upload --file tools/port-plugins/rt-architecture-map/index.html --identifier rt-architecture-map --title "Retail Tower Architecture Map" --params "{}" --description "Live architecture map coloured from Port data" --upsert
```

The widget on the Cockpit is `ck_arch` (`pluginId: rt-architecture-map`, no `paramValues`).
