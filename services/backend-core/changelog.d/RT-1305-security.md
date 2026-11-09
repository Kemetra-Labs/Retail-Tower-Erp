### Security
- RT-1305: the Admin Console CSP served by Caddy may allow one `frame-src`, the pilot release
  bucket's virtual-hosted S3 origin `https://<bucket>.s3.<region>.amazonaws.com`, so the Console's
  Download POS can hand the presigned installer URL to a hidden iframe (RT-1304). It is added only
  when the host sets a valid `POS_PILOT_RELEASE_BUCKET` and `POS_PILOT_RELEASE_S3_REGION` (now also
  passed to the caddy container; the S3 key is not); unset or malformed, the CSP is unchanged. Every
  other directive is unchanged, and `deploy/console-smoke.sh` now checks the exact CSP string.
