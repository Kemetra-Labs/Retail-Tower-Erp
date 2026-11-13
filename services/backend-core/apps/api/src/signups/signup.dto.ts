/**
 * Request bodies of the two PUBLIC signup routes (RT-1350 slice 3; contract
 * `packages/contracts/openapi/signups.openapi.yaml`) and the one generic 400 they share.
 *
 * The contract says a malformed body, a non-current `termsVersion`, a failed human
 * proof, and (on complete) an invalid token or a rejected password are the SAME
 * refusal: `code: validation_error`, one fixed message, no field details. So these
 * routes do not use the global `ZodValidationPipe` (its ZodError becomes an
 * envelope with `details`, which would tell a caller which field failed).
 */
import { type ArgumentMetadata, BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import { Email } from "@data-pulse-2/shared";
import { z, type ZodTypeAny } from "zod";

import { passwordString } from "../auth/dto";

/** The one message of every signup 400. Never varies by cause. */
export const SIGNUP_INVALID_MESSAGE = "The request could not be processed.";

/** The generic 400 of both signup routes. */
export function signupInvalid(): BadRequestException {
  return new BadRequestException({ code: "validation_error", message: SIGNUP_INVALID_MESSAGE });
}

/** `POST /api/v1/signups` */
export const SignupRequestSchema = z
  .object({
    email: Email,
    name: z.string().min(1).max(120),
    businessName: z.string().min(1).max(120),
    locale: z.enum(["ar", "en"]).optional(),
    termsVersion: z.string().min(1).max(64),
    termsAccepted: z.literal(true),
    humanProof: z.string().min(1).max(4096),
  })
  .strict();
export type SignupRequestInput = z.infer<typeof SignupRequestSchema>;

/** `POST /api/v1/signups/complete` */
export const SignupCompleteSchema = z
  .object({
    token: z.string().min(1).max(2048),
    password: passwordString(1),
  })
  .strict();
export type SignupCompleteInput = z.infer<typeof SignupCompleteSchema>;

/** Validates a body against `schema`; any failure is the generic 400, with no detail. */
@Injectable()
export class SignupValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, _metadata?: ArgumentMetadata): z.infer<TSchema> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw signupInvalid();
    return parsed.data as z.infer<TSchema>;
  }
}
