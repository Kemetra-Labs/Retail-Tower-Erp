# Admin Console release artifact (RT-337)

The Admin Console ships as a pinned, immutable static bundle. Per the
owner-approved hosting decision in RT-315, Backend-Core's Caddy gateway is
planned to serve it on the same public HTTPS origin as the API (`/` → this
bundle, `/api/*` → Backend-Core). That serving, release and rollback on the host
are owned by RT-336 (Backend-Core) and are **not implemented yet**. This
repository builds and publishes the bundle; it does not deploy it.

## Producing a release

Since the monorepo cutover (RT-715) the release is the root workflow
`.github/workflows/release-admin-console.yml` (RT-871): an `admin-console/vX.Y.Z` tag push,
or a manual dispatch that defaults to a dry-run. Its build job runs `pnpm build` and then
`release-artifact.ts`, which writes `dist/version.json`. The product workflow
`release-artifact.yml` that this page first described was retired in RT-878 (GitHub never
ran it from a nested `.github/`).

The build refuses to release when:

- the release SHA is not on `main`, or a non-dry-run is not on an `admin-console/vX.Y.Z` tag;
- `VITE_API_BASE_URL` is set, either in the build environment or in a root
  `.env*` file that `vite build` loads. Vite inlines it into the bundle and would
  replace the same-origin API default;
- `dist/` lacks `index.html` or `assets/`, or contains source maps or `.env*` files.

An `admin-console/vX.Y.Z` tag publishes (RT-717 C1). The publish job runs behind the
`release-admin-console` environment (owner reviewer, tag-only policy) and refuses to run
if that environment is not set up that way. It checks that the archive is the one the
manifest recorded, attests its build provenance and creates an immutable GitHub release.
A dry-run publishes nothing: its tarball and manifest stay workflow artifacts, named
`admin-console-dist-<sha12>.tar.gz`. The archive content (`dist/` with `version.json`)
and the serving rules are unchanged.

## Artifact contract (consumed by RT-336)

Release tag `admin-console/vX.Y.Z` (the former `admin-console-<sha12>` tags belong to the
frozen `Kemetra/Admin-Console` repository) holds three assets:

| Asset | Content |
| --- | --- |
| `admin-console-vX.Y.Z.tar.gz` | Archive root = the built `dist/`: `index.html`, `assets/`, `version.json` |
| `admin-console-vX.Y.Z.tar.gz.sha256` | `sha256sum` line for the archive |
| `release-manifest.json` | Source SHA, `apps/admin-console` tree hash, archive digest, Backend-Core contract snapshot and CI URL |

Serving rules for the host:

| Path | Cache policy |
| --- | --- |
| `/assets/*` | Content-hashed by Vite: `public, max-age=31536000, immutable` |
| `/index.html` and SPA fallback | `no-cache` |
| `/version.json` | `no-cache` (publicly readable) |
| Any other root file | `no-cache` unless it is content-hashed |

`version.json` is public. It contains only:

```json
{
  "app": "retail-tower-console",
  "sha": "<40-char Admin Console commit>",
  "builtAt": "<ISO-8601 UTC build time>",
  "backendContractPin": "<Backend-Core contract pin from contracts/backend-core/PIN>"
}
```

No secrets, hostnames, environment values or tenant data belong in the bundle or
in `version.json`.

The bundle embeds only its own commit SHA (`GITHUB_SHA` at build time) as the
Sentry release (RT-633). Everything else arrives at runtime from Backend-Core's
OBS-3 contract (RT-632):

| Path | Role |
| --- | --- |
| `GET /api/v1/console/telemetry/config` | `204`: Sentry off, no SDK init. `200`: `{ tunnel, environment }`. Never a DSN. |
| `/api/v1/console/telemetry/envelope` | Same-origin tunnel. It ignores the envelope DSN and forwards to the configured Console Sentry project. |

The SDK starts with a fixed placeholder DSN (`.invalid` host), so the real DSN
never reaches the browser. Until the Console reads the config endpoint (a
follow-up after the contract merges and the client pin is bumped), it sends no
telemetry.

## Verifying before deployment

```bash
TAG=admin-console/vX.Y.Z
gh release download "$TAG" --repo Kemetra-Labs/Retail-Tower-Erp
sha256sum -c admin-console-vX.Y.Z.tar.gz.sha256
gh attestation verify admin-console-vX.Y.Z.tar.gz --repo Kemetra-Labs/Retail-Tower-Erp \
  --signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-admin-console.yml
tar -xzf admin-console-vX.Y.Z.tar.gz -C <pinned-console-dir>
```

Record the deployed pair for every deployment: Admin Console `sha` and
`backendContractPin` from `version.json`, plus the Backend-Core commit and image
digests actually running. The planned rollback (RT-336, not implemented yet) is
re-pointing the host to the previously recorded artifact directory.
