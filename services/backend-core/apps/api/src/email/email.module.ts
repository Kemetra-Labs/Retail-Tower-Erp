/**
 * EmailModule (RT-1466, audit A-10): owns the email-job seam that `AuthModule` used to provide.
 * Producers here (password reset, email verification, invitations, signup links) enqueue jobs that
 * the worker's `email` processor delivers. Global, so a module that used to receive
 * `EMAIL_JOB_ENQUEUER` through `AuthModule`'s exports still resolves it; direct consumers
 * (AuthModule, MembershipsModule, SignupsModule) also import it explicitly.
 */
import { Global, Module } from "@nestjs/common";

import { emailJobEnqueuerFactory } from "./email-job-enqueuer.factory";
import { EMAIL_JOB_ENQUEUER } from "./email-job.enqueuer";

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_JOB_ENQUEUER,
      useFactory: emailJobEnqueuerFactory,
    },
  ],
  exports: [EMAIL_JOB_ENQUEUER],
})
export class EmailModule {}
