/**
 * Fallback A adapter of the signup-link port (RT-1350 slice 3; owner decision c16859,
 * confirmed by the spike S0 result): Backend-Core's own opaque, single-use token.
 *
 * 32 random bytes (base64url, 43 characters); only the SHA-256 (hex) is stored, in
 * `pending_signups.token_hash`; the raw token travels once, in the `auth.signup-link`
 * email job (the worker renders `<console base>/signup/complete?token=`). The token never
 * appears in a log. Verification is a pure hash: the pending row is then found by that hash,
 * so there is no network call and no outage.
 */
import { createHash } from "node:crypto";

import { generateRawToken } from "@data-pulse-2/auth";

import type { EmailJobEnqueuer } from "../auth/email-job.enqueuer";
import type {
  PreparedSignupLink,
  PrepareLinkInput,
  SignupLinkProvider,
  VerifyLinkResult,
} from "./signup-link.port";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class OwnTokenSignupLinkProvider implements SignupLinkProvider {
  constructor(private readonly emailJobs: Pick<EmailJobEnqueuer, "enqueueSignupLink">) {}

  prepare(input: PrepareLinkInput): PreparedSignupLink {
    const rawToken = generateRawToken();
    return {
      tokenHash: sha256Hex(rawToken),
      deliver: () => this.emailJobs.enqueueSignupLink({ email: input.email, rawToken, locale: input.locale }),
    };
  }

  verify(opaqueToken: string): Promise<VerifyLinkResult> {
    return Promise.resolve({ kind: "ok", tokenHash: sha256Hex(opaqueToken), email: null });
  }
}
