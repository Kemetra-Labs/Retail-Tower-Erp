# POS terminals — fixture contract (RT-1281)

> **Documentation only.** No credentials, IDs or data live in this repo. An
> operator provisions these in the **isolated AWS lab with synthetic data**
> before RT-317 authorizes a run (RT-1279 boundaries: no real customer data,
> payment or fiscal writes).

`pos-terminals.js`, `offline-burst.js` and `sales-capture.js` capture sales the
way a paired terminal does (`sales.yaml`, `device` scheme): the terminal's
device token, `operatorUserId` in the body, and a live cashier admission of
that device, store and user covering the sale's `occurredAt`. No provider
(Descope) sign-in is scripted.

## What to provision (one synthetic tenant, one store)

| Item | How | Count |
| --- | --- | --- |
| Synthetic tenant and store | Console, lab only | 1 + 1 |
| Cashier users (members with store access) | Console invitations to `*@example.invalid` style addresses | 10 (one per terminal) |
| Paired terminals | Console `consoleIssuePairingCode`, then `POST /api/pos/v1/terminals/pair` with each code; keep each returned `device_token` | 10 |
| Seeded products with store prices | Console catalog | about 200 |
| ERP mapping for those products | Connector item map on the lab ERP company | all seeded products |

A cashier is admitted per run in each script's `setup()`
(`POST /api/pos/v1/cashier-admissions`, `mode: online`, or `reconcile_offline`
for the burst). Give each terminal its own cashier: one cashier on two
terminals gets `active_elsewhere`.

## Environment (inject with `op run`; never commit)

```
BASE_URL=https://<lab host>
LOAD_TERMINALS=3                      # 1, 3 or 10 (max 10)
LOAD_TERMINAL_1_TOKEN=op://<vault>/<item>/device-token-1
LOAD_TERMINAL_1_CASHIER_ID=<users.id of cashier 1>
...                                   # up to LOAD_TERMINAL_10_*
LOAD_PRODUCTS=[{"ref":"<product id>","name":"<name>","price":"12.50"}, ...]
LOAD_CURRENCY=EGP                     # the tenant currency
LOAD_SALES_PER_HOUR=<owner-set>       # pos-terminals.js only
LOAD_BURST_SALES=<K>  LOAD_OFFLINE_MINUTES=<M>   # offline-burst.js only
LOAD_ABORT_ERROR_RATE=<owner-set, e.g. 0.01>
LOAD_ABORT_P95_MS=<owner-set>
LOAD_RUN_ID=rt317-<date>-<step>       # marks the run's sales for the reconciliation
```

Required values have no defaults on purpose: a run without the owner's rate and
abort thresholds does not start.

## Cleanup

k6 sales are real rows in the lab (`source_system = 'k6-perf'`, `external_id`
starting with `LOAD_RUN_ID`). They are kept as run evidence until the owner
decides otherwise. They are never deleted by these scripts.
