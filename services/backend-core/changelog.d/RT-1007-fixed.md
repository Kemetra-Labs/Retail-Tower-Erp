### Fixed
- RT-1007: `deploy/README.md` said the Console lab deploy needed no trust-policy change.
  The deploy role's trust policy pins `job_workflow_ref` to a list of deploy workflows, so
  `deploy-console-lab.yml` has to be added to it; the first live run failed at the role
  assumption until it was. The owner steps now include that change, and the residual
  risks describe the workflow pin.
