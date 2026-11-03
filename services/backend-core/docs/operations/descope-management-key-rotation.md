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
4. **Verify one invite accept.** Accept one test invitation end to end. A `503` means
   the key is unset or not read; a Descope auth error means the new key is wrong or
   lacks the role. Keep the old key live until this passes.
5. **Revoke the old key (owner).** Delete it in the Descope console, then repeat the
   invite accept once to confirm nothing still uses it.
6. **Purge backup copies.** `deploy/lab/ssm/RT-BackendLabDeploy.yaml` (`backup-config`,
   about lines 336 to 404) copies `backend.env` on every live deploy. List them with
   `ls -l` and delete the ones from before step 2:
   - `/var/lib/rt-deploy/<RUN_ID>/backend.env` and `backend.env.next` (run dirs, mode `0700`)
   - `/root/rt-lab-secrets/backend.env.bak-pre-<target>-<RUN_ID>`

   Do not purge a run dir that holds `REVERT-BLOCKED` or an auto-revert still pending;
   its `backend.env` is what a revert restores, so rotate again after that run is closed.
   Old copies hold the revoked key, so they are harmless after step 5, but remove them
   so the next reader does not mistake them for current.

Record the date and the Jira issue of each rotation. Do not record the key.
