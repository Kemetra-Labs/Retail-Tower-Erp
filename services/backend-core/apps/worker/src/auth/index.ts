/**
 * The worker's `auth` port (RT-1525; RT-1453 port convention). Other worker modules read users
 * through here, never with their own SQL on `users`.
 */
export { liveUserEmails } from "./live-user-emails";
