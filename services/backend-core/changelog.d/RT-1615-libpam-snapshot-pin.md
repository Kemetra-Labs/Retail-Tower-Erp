### Security
- RT-1615 `[GATED]`, owner authorization 2026-11-27 (RT-1615 c19127): the base stage of
  `Dockerfile` installs exactly `libpam0g`, `libpam-modules`, `libpam-modules-bin` and
  `libpam-runtime` at `1.5.2-6+deb12u3` (Debian DLA-4941-1) from a signature-verified
  snapshot.debian.org bookworm-security timestamp, clearing CVE-2025-6020 and CVE-2024-22365
  in the api, worker and migrate images. The base digest, Node and glibc are unchanged.
  This corrects the RT-1614 entry: that digest bump cleared apt (CVE-2026-109518) but still
  shipped libpam 1.5.2-6+deb12u2.
