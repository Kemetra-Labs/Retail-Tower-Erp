### Fixed
- RT-1007: `deploy/README.md` said the Console lab deploy needed no trust-policy change.
  The deploy role's trust policy pins `job_workflow_ref` to a list of deploy workflows, so
  `deploy-console-lab.yml` has to be added to it; the first live run failed at the role
  assumption until it was. The owner steps now include that change, and the residual
  risks describe the workflow pin.
- RT-1007: `deploy/lab/oidc-claims-check.cjs` told every deploy run that the trust policy
  pins `deploy-lab.yml`. When `deploy-erp-lab.yml` or `deploy-console-lab.yml` runs the
  check, it now names that workflow as the value to pin; the diagnostic workflow still
  gets `deploy-lab.yml`.
