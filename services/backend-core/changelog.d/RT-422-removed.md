### Removed
- RT-422 `[GATED: migration, contract]`, owner authorization Jira RT-422 comment 18024: the spec-035 A/R ledger
  leaves Backend-Core (RT-413 Option B; ERPNext owns receivables). The settlement-intent, receivable read and list,
  apply-payment, claim and reconcile-remittance routes, their services and DTOs, the `posWriteSettlementIntent`
  rate-limit bucket and the `settlement_receivable_total` metric are removed. Migration `0129_retire_settlement_ledger`
  drops `reconciliation_result`, `remittance`, `claim_receivables`, `payment_application`, `claim` and `receivable`
  after refusing if any holds a row in any tenant (RT-416: all empty on the lab). `payer_account`, the payer routes
  and `sale_responsibilities` are untouched. The `settlement.receivable.*` audit read codes move to the retired list.
  Deploy order: run `migrate` (0129) after the new API is live; the old API's settlement routes fail once the tables are gone.
