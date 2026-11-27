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
  "auth.signIn.welcome": "Welcome back",
  "auth.signIn.forgotPassword": "Forgot password?",

  "auth.forgotPassword.title": "Reset your password",
  "auth.forgotPassword.subtitle":
    "Enter your email and we will send a reset link if an account is registered for it.",
  "auth.forgotPassword.submit": "Send reset link",
  "auth.forgotPassword.submitting": "Sending",
  "auth.forgotPassword.sent.title": "Check your email.",
  "auth.forgotPassword.sent.body":
    "If that email is associated with an account, a password reset link will arrive shortly. Check your spam folder if you do not see it.",
  "auth.forgotPassword.tryAnother": "Use a different email",
  "auth.forgotPassword.backToSignIn": "Back to sign in",
  "auth.forgotPassword.errors.emailRequired": "Enter your email address.",
  "auth.forgotPassword.errors.invalidEmail": "Enter a valid email address.",
  "auth.forgotPassword.errors.unavailable":
    "The service is temporarily unavailable. Try again shortly.",
  "auth.forgotPassword.errors.failed": "Could not send the request right now. Try again shortly.",

  "auth.resetPassword.title": "Set a new password",
  "auth.resetPassword.titleInvalid": "Invalid link",
  "auth.resetPassword.subtitle": "Choose a new password for your account.",
  "auth.resetPassword.submit": "Save new password",
  "auth.resetPassword.submitting": "Saving",
  "auth.resetPassword.done.title": "Password updated.",
  "auth.resetPassword.done.body":
    "You were signed out of your previous sessions. You can now sign in with your new password.",
  "auth.resetPassword.requestNewLink": "Request a new link",
  "auth.resetPassword.errors.missingLink":
    "This reset link is invalid or incomplete. Request a new link.",
  "auth.resetPassword.errors.invalidOrRefused":
    "Could not reset the password. The link may be invalid or expired, or the password may not meet your identity provider's rules.",
  "auth.resetPassword.errors.unavailable":
    "The service is temporarily unavailable. Try again shortly.",
  "auth.resetPassword.errors.failed": "Could not update the password right now. Try again shortly.",

  "auth.password.show": "Show password",
  "auth.brand.tagline": "Every branch, under your eye",

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

  "auth.account.title": "My account",
  "auth.account.subtitle": "For the account {email}.",
  "auth.account.password.title": "Change password",
  "auth.account.current.label": "Current password",
  "auth.account.new.label": "New password",
  "auth.account.new.hint": "Your identity provider sets the password rules.",
  "auth.account.confirm.label": "Confirm new password",
  "auth.account.submit": "Change password",
  "auth.account.cancel": "Cancel",
  "auth.account.errors.currentRequired": "Enter your current password.",
  "auth.account.errors.newRequired": "Enter a new password.",
  "auth.account.errors.confirmRequired": "Enter the new password again.",
  "auth.account.errors.mismatch": "The new passwords do not match.",
  "auth.account.changed.title": "Password changed.",
  "auth.account.changed.body":
    "You were signed out of your other sessions. This session stays open.",
  "auth.account.errors.refused.title": "Could not change the password.",
  "auth.account.errors.refused.body":
    "Check your current password, choose a new one your identity provider's rules accept, then try again.",
  "auth.account.errors.noLink":
    "The password cannot be changed here. Your account is not linked to the identity provider yet. Ask your organization's admin for help.",
  "auth.account.errors.notConfirmed":
    "The request could not be completed right now, and the password change is not confirmed. Try again shortly.",
  "auth.account.errors.sessionExpired": "Your session ended. Sign in again.",
  "auth.account.errors.failed":
    "Could not change the password, and it was not changed. Reload the page, then try again.",
  "auth.account.aside.title": "What happens after the change",
  "auth.account.aside.provider":
    "The password is replaced at your identity provider, not in the Console.",
  "auth.account.aside.sessions":
    "You are signed out of your other sessions. This session stays open.",

  "auth.noAccess.title": "No assigned access",
  "auth.noAccess.body":
    "You're signed in, but your account has no tenant or store access yet. Contact your administrator to be granted a membership.",
  "auth.noAccess.signOut": "Sign out",
};
