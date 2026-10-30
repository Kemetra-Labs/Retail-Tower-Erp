import type { auth as ar } from "../ar/auth";
import type { MessagesOf } from "../types";

export const auth: MessagesOf<typeof ar> = {
  "auth.signIn.title": "Sign in",
  "auth.signIn.subtitle": "Manage your stores, catalog and sales.",
  "auth.signIn.email.label": "Email",
  "auth.signIn.password.label": "Password",
  "auth.signIn.submit": "Sign in",
  "auth.signIn.submitting": "Signing in",
  "auth.signIn.retryIn": { one: "Try again in {count}s", other: "Try again in {count}s" },
  "auth.signIn.errors.failed": "Sign-in failed. Check your email and password, then try again.",
  "auth.signIn.errors.rateLimited": {
    one: "Too many attempts. You can try again in {count}s.",
    other: "Too many attempts. You can try again in {count}s.",
  },
  "auth.signIn.footer": "Protected platform · all activity is audited",
  "auth.signIn.invitesOnly":
    "Invitations arrive by email from your organization's admin. There is no self sign-up.",

  "auth.password.show": "Show password",
  "auth.brand.flowTitle": "From the till to the books",
  "auth.brand.flowPos": "POS",
  "auth.brand.flowServer": "Server",
  "auth.brand.headline": "All your stores in one place, with numbers you can trust.",
  "auth.brand.body":
    "Sales, stock, devices and ledger posting, from the same record the cashier sees.",

  "auth.acceptInvitation.title": "Accept your invitation",
  "auth.acceptInvitation.titleInvalid": "Invitation",
  "auth.acceptInvitation.subtitle":
    "New here? Choose a display name and a password. Already have an account? Leave both empty.",
  "auth.acceptInvitation.displayName.label": "Display name",
  "auth.acceptInvitation.password.label": "Password",
  "auth.acceptInvitation.password.hint": "Required for a new account.",
  "auth.acceptInvitation.submit": "Accept invitation",
  "auth.acceptInvitation.submitting": "Accepting",
  "auth.acceptInvitation.errors.invalidLink": "This invitation link is invalid or has expired.",
  "auth.acceptInvitation.goToSignIn": "Go to sign in",
  "auth.acceptInvitation.haveAccess": "Already have access? {signIn}",
  "auth.acceptInvitation.signInLink": "Sign in",

  "auth.noAccess.title": "No assigned access",
  "auth.noAccess.body":
    "You're signed in, but your account has no tenant or store access yet. Contact your administrator to be granted a membership.",
  "auth.noAccess.signOut": "Sign out",
};
