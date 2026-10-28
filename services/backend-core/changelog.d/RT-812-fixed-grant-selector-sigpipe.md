### Fixed
- RT-812: `deploy/apply-domain-grants.sh` could skip a marked routine grant
  script. Its `tr | grep -q` check failed under `pipefail` when grep matched
  before tr finished writing (SIGPIPE), so the script was treated as unmarked
  and left out of deploy step 2 and the release bundle. grep now reads to the
  end of the file.
