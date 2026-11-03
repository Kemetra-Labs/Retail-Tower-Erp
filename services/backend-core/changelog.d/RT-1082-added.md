### Added
- RT-1082 `[GATED: .github]` (slice S2, under RT-717; the issue authorizes this deploy area):
  the SSM document `deploy/lab/ssm/RT-PosLabFeedDeploy.yaml` for the root workflow
  `deploy-pos-lab.yml`, which puts one lab-signed `pos/vX.Y.Z` release into the POS lab update
  feed on lab-01. The document is the security boundary. It refuses a version that is not
  higher than the one the feed serves, fetches the installer, its blockmap and `lab.yml` over
  https into a root-only staging directory, and checks them against the digests the workflow
  verified and `lab.yml` against the installer. It renames the installer and blockmap into the
  feed first and `lab.yml` last, smokes the feed on the host, puts the previous `lab.yml` back
  on a failed smoke, and keeps the current and one previous version. It takes the lab-01
  deploy lock. `deploy/README.md` documents the workflow and the owner-only host, Caddy and
  AWS steps. `lab-ssm-documents.spec.ts` covers the new document.
