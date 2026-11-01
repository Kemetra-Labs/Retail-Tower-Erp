### Added
- RT-473 S2 `[GATED]`, owner approval (spec 039 OD-1/OD-2, RT-472 comment 11856; OD-7 RT-473
  comment 13662; OD-8 owner decision 2026-10-31, RT-473 comment 14883): the tenant logo runtime of
  `tenant-branding.openapi.yaml`. Migration `0076_tenant_logo_branding` (approved as `0046`) adds
  `tenant_branding_revisions`, `tenant_logos` and `tenant_logo_renditions` under FORCE RLS, with
  `docs/operations/sql/tenant-branding-domain-grants.sql`. The Console reads, previews, saves and
  removes the logo (session-only, `owner` / `tenant_admin`, optimistic `expected_revision`) and the
  POS reads it with its device token (`ETag` / `304`, `logo: null` when none). Uploads are PNG or
  SVG by magic bytes only, at most 1 MiB, with a header bomb guard, a refuse-list SVG gate and
  resvg rasterization with every resource off; normalized masters, 8 screen renditions at the
  OD-7 boxes and a 1-bit Floyd–Steinberg receipt rendition at 203 dpi (≤ 383 × 119 dots) are
  rendered by deterministic in-repo code. New dependencies `sharp` 0.35.5 and `@resvg/resvg-js`
  2.6.2 (pinned).
