/**
 * Email templates — slice 5 (T115).
 *
 * Pure functions. No I/O. No `process.env`. The invitation template takes
 * the Admin Console origin as an argument (RT-1280; resolved once at boot
 * by `email.config.ts`) and renders an accept link. The password-reset and
 * email-verification templates still embed the bare token.
 *
 * Why no userId in the body, subject, or tags?
 * --------------------------------------------
 * The recipient already knows who they are; surfacing their internal
 * UUID would be an unforced PII leak (it can show in mail-archive
 * search, screenshots, support pastes, etc.). The producer's `userId`
 * is for audit / dedupe only — the templates discard it.
 *
 * Tags
 * ----
 * `template_id` is a stable, non-PII label that real providers
 * (SendGrid, Postmark, etc.) use for analytics. We pre-emptively put
 * one on every message so the future provider integration has the
 * dashboard hook it needs without a template change.
 */
import type { EmailMessage } from "./email.adapter";

/**
 * Validated job shape after Zod parsing in the processor. We keep this
 * narrow on purpose: templates have no business knowing about producer
 * concerns.
 */
export interface RenderableEmailJob {
  readonly email: string;
  readonly rawToken: string;
}

export interface RenderableInvitationJob {
  readonly email: string;
  readonly rawToken: string;
  readonly tenantId: string;
}

export function renderPasswordResetEmail(
  job: RenderableEmailJob,
): EmailMessage {
  const { email, rawToken } = job;
  const textBody =
    "We received a request to reset your password.\n\n" +
    `Use this code to complete the reset: ${rawToken}\n\n` +
    "If you did not request this, you can ignore this email — your password will not change.";
  const htmlBody =
    "<p>We received a request to reset your password.</p>" +
    `<p>Use this code to complete the reset: <code>${rawToken}</code></p>` +
    "<p>If you did not request this, you can ignore this email — your password will not change.</p>";

  return {
    to: email,
    subject: "Reset your password",
    textBody,
    htmlBody,
    tags: { template_id: "auth.password-reset" },
  };
}

/** Minimal HTML escaping for text and attribute values we interpolate. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The Admin Console accept link (RT-1280). `consoleBaseUrl` is an https
 * origin already validated by `parseConsoleBaseUrl`; the route is the
 * Console's `/accept-invitation?token=` (apps/admin-console `App.tsx`).
 */
function invitationAcceptUrl(consoleBaseUrl: string, rawToken: string): string {
  return `${consoleBaseUrl}/accept-invitation?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Invitation email, Arabic first then English (RT-1280; wording is a draft
 * pending owner approval). "7 days" mirrors `INVITATION_TTL_MS` in
 * `apps/api/src/memberships/invitations.service.ts`; change both together.
 *
 * `consoleBaseUrl` is required in production (`resolveEmailConfig`). Only a
 * non-production worker with no Console URL falls back to the bare token.
 */
export function renderInvitationEmail(
  job: RenderableInvitationJob,
  consoleBaseUrl: string | null = null,
): EmailMessage {
  const { email, rawToken } = job;
  const link = consoleBaseUrl === null ? null : invitationAcceptUrl(consoleBaseUrl, rawToken);
  const action = link ?? rawToken;
  const actionHtml =
    link === null
      ? `<code>${escapeHtml(rawToken)}</code>`
      : `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;
  const leadAr = link === null ? "استخدم هذا الرمز لقبول الدعوة:" : "افتح هذا الرابط لقبول الدعوة:";
  const leadEn =
    link === null ? "Use this token to accept the invitation:" : "Open this link to accept the invitation:";

  const textBody =
    "تمت دعوتك للانضمام إلى فريق على Retail Tower OS.\n\n" +
    `${leadAr}\n${action}\n\n` +
    "يمكن استخدام الدعوة مرة واحدة فقط، وتنتهي صلاحيتها بعد 7 أيام من إرسالها.\n" +
    "إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل هذه الرسالة.\n\n" +
    "----\n\n" +
    "You have been invited to join a team on Retail Tower OS.\n\n" +
    `${leadEn}\n${action}\n\n` +
    "The invitation can be used once and expires 7 days after it was sent.\n" +
    "If you did not expect this invitation, you can ignore this email.";
  const htmlBody =
    '<div dir="rtl" lang="ar">' +
    "<p>تمت دعوتك للانضمام إلى فريق على Retail Tower OS.</p>" +
    `<p>${leadAr}<br>${actionHtml}</p>` +
    "<p>يمكن استخدام الدعوة مرة واحدة فقط، وتنتهي صلاحيتها بعد 7 أيام من إرسالها.</p>" +
    "<p>إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل هذه الرسالة.</p>" +
    "</div><hr>" +
    '<div dir="ltr" lang="en">' +
    "<p>You have been invited to join a team on Retail Tower OS.</p>" +
    `<p>${leadEn}<br>${actionHtml}</p>` +
    "<p>The invitation can be used once and expires 7 days after it was sent.</p>" +
    "<p>If you did not expect this invitation, you can ignore this email.</p>" +
    "</div>";

  return {
    to: email,
    subject: "You have been invited to Retail Tower OS | دعوة للانضمام إلى Retail Tower OS",
    textBody,
    htmlBody,
    tags: { template_id: "memberships.invitation" },
  };
}

export interface RenderableSignupLinkJob {
  readonly email: string;
  readonly rawToken: string;
  readonly locale: "ar" | "en" | null;
}

/**
 * The Console completion link of a self-signup (RT-1350 slice 3). The route is the
 * Console's `/signup/complete?token=` (the page itself ships with a later slice).
 */
function signupCompleteUrl(consoleBaseUrl: string, rawToken: string): string {
  return `${consoleBaseUrl}/signup/complete?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Self-signup link email, Arabic and English, the form's language first (Arabic when
 * the form sent none). DRAFT WORDING: pending the owner's approval, an open item for
 * launch gate G (RT-1350). "24 hours" mirrors `SIGNUP_LINK_TTL_MS` in
 * `apps/api/src/signups/signup.config.ts`; change both together.
 *
 * Nothing about the owner or the business appears in the message: only the recipient.
 * `consoleBaseUrl` is required in production; only a non-production worker with no
 * Console URL falls back to the bare token.
 */
export function renderSignupLinkEmail(
  job: RenderableSignupLinkJob,
  consoleBaseUrl: string | null = null,
): EmailMessage {
  const { email, rawToken, locale } = job;
  const link = consoleBaseUrl === null ? null : signupCompleteUrl(consoleBaseUrl, rawToken);
  const action = link ?? rawToken;
  const actionHtml =
    link === null
      ? `<code>${escapeHtml(rawToken)}</code>`
      : `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;

  const ar = {
    dir: "rtl",
    lang: "ar",
    welcome: "مرحبًا بك في Retail Tower OS.",
    lead: link === null ? "استخدم هذا الرمز لإكمال إنشاء حسابك:" : "افتح هذا الرابط لإكمال إنشاء حسابك:",
    expiry: "يمكن استخدام الرابط مرة واحدة فقط، وتنتهي صلاحيته بعد 24 ساعة من إرساله.",
    ignore: "إذا لم تطلب إنشاء حساب، يمكنك تجاهل هذه الرسالة.",
  } as const;
  const en = {
    dir: "ltr",
    lang: "en",
    welcome: "Welcome to Retail Tower OS.",
    lead: link === null ? "Use this token to finish creating your account:" : "Open this link to finish creating your account:",
    expiry: "The link can be used once and expires 24 hours after it was sent.",
    ignore: "If you did not ask to create an account, you can ignore this email.",
  } as const;
  const blocks = locale === "en" ? [en, ar] : [ar, en];

  const textBody = blocks
    .map((b) => `${b.welcome}\n\n${b.lead}\n${action}\n\n${b.expiry}\n${b.ignore}`)
    .join("\n\n----\n\n");
  const htmlBody = blocks
    .map(
      (b) =>
        `<div dir="${b.dir}" lang="${b.lang}"><p>${b.welcome}</p><p>${b.lead}<br>${actionHtml}</p>` +
        `<p>${b.expiry}</p><p>${b.ignore}</p></div>`,
    )
    .join("<hr>");

  return {
    to: email,
    subject: "Finish creating your Retail Tower OS account | أكمل إنشاء حسابك على Retail Tower OS",
    textBody,
    htmlBody,
    tags: { template_id: "auth.signup-link" },
  };
}

export function renderEmailVerificationEmail(
  job: RenderableEmailJob,
): EmailMessage {
  const { email, rawToken } = job;
  const textBody =
    "Welcome — please confirm your email address.\n\n" +
    `Use this code to verify: ${rawToken}\n\n` +
    "If you did not create an account, you can ignore this email.";
  const htmlBody =
    "<p>Welcome — please confirm your email address.</p>" +
    `<p>Use this code to verify: <code>${rawToken}</code></p>` +
    "<p>If you did not create an account, you can ignore this email.</p>";

  return {
    to: email,
    subject: "Verify your email address",
    textBody,
    htmlBody,
    tags: { template_id: "auth.email-verify" },
  };
}
