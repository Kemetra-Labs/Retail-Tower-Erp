### Added
- RT-1007 `[GATED: .github]` (RT-717 Phase C7, owner decisions C7-D1..D4 and c14794): the
  SSM document `deploy/lab/ssm/RT-ConsoleLabDeploy.yaml` for the root workflow
  `deploy-console-lab.yml`, the automated Admin Console deploy to lab-01. The document is the
  security boundary. It checks that lab-01 runs the given Backend-Core release, fetches the
  `admin-console/vX.Y.Z` archive over https, and checks it against its `.sha256` and the
  attested digest the workflow verified. It then checks `version.json` (commit and contract
  pin), swaps the `current` symlink atomically, smokes the origin, and swaps back on a failed
  smoke. It takes the Backend-Core deploy's host lock, deletes nothing and restarts nothing.
  Only monorepo releases are deployed; a rollback to a legacy directory stays manual.
  `deploy/README.md` documents the workflow, the owner-only AWS steps, and a `curl` path for
  hosts without `gh`. `lab-ssm-documents.spec.ts` covers the new document.
