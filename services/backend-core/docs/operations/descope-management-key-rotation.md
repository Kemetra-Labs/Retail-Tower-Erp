# Rotate `DESCOPE_MANAGEMENT_KEY` (RT-1123)

The key is used only for invite accept (RT-937: `createUser`, `loadUser`,
`setActivePassword`). While it is missing or wrong, invite accept answers `503`;
sign-in keeps working. See
[`deploy/README.md`](../../deploy/README.md#descope_management_key-rt-937-rt-1123).

Never print, paste or commit the key, and never `cat` `backend.env`. Check
permissions and names only. Rotate on a schedule the owner sets, and at once if
the key may have leaked (a backup copy, a log, a shared screen).

1. **Create a new key (owner).** In the Descope console, create a Management key
   with the least role that allows user create, load and password set. Do not edit
   the old key yet. Copy it straight to the host, never through chat or a ticket.
2. **Update the lab env file.** On lab-01 set `DESCOPE_MANAGEMENT_KEY` in
   `/root/rt-lab-secrets/backend.env` (root only, mode `0600`). Edit in place with
   an editor; do not echo the value.
3. **Restart the API.** Recreate it so it re-reads the env file, for example
   `/opt/rt-lab/backend/dc up -d --force-recreate api`. Confirm the container is healthy.
4. **Verify one new-user invite accept.** Create an invitation for a fresh email with no
   existing Backend-Core or Descope user, then accept it end to end (only the new-user
   path calls the Management API). A `503` means
   the key is unset, not read, invalid, or insufficiently authorized; invite accept does
   not return a separate Descope auth error. Check the key and its role. Keep the old key
   live until this passes.
5. **Revoke the old key (owner).** First confirm that no earlier `rt-deploy-revert-*` unit
   is armed or has fired, and inspect that unit's run dir. If a timer is armed, wait for
   its run to close. If `REVERT-STARTED` exists without `REVERTED` or `REVERT-BLOCKED`, do not
   revoke the old key; wait for or resolve the in-progress revert. If
   `REVERT-BLOCKED` exists, complete the owner restore or forward-fix before
   continuing. If `REVERTED` exists, repeat steps 2 to 4 after the restore. Then
   delete the old key in the Descope console, and accept an invitation for another fresh
   email (same rule as step 4) to confirm the new key works on its own.
6. **Purge backup copies.** `deploy/lab/ssm/RT-BackendLabDeploy.yaml` (`backup-config`,
   about lines 335 to 362) copies `backend.env` on every live deploy. List them with
   `ls -l` and delete the ones from before step 2:
   - `/var/lib/rt-deploy/<RUN_ID>/backend.env` and `backend.env.next` (run dirs, mode `0700`)
   - `/root/rt-lab-secrets/backend.env.bak-pre-<target>-<RUN_ID>`

   Do not purge a run dir with an auto-revert still pending; its `backend.env` is what a
   revert restores, so rotate again after that run is closed.
   Old copies hold the revoked key, so they are harmless after step 5, but remove them
   so the next reader does not mistake them for current.

Record the date and the Jira issue of each rotation. Do not record the key.
