/**
 * The email queue's job names (moved from email.processor.ts, RT-1551). They must match the producer
 * literally; see the email.processor unit tests. A plain constant, so the `email` port can re-export it
 * without loading the processor.
 */
export const EMAIL_JOB_NAMES = {
  passwordReset: "auth.password-reset",
  emailVerification: "auth.email-verify",
  invitation: "memberships.invitation",
  signupLink: "auth.signup-link",
} as const;
