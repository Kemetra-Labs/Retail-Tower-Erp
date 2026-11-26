/**
 * The public surface of the api side of `email` (RT-1466, RT-1453 convention): the enqueuer seam,
 * its DI token and the module. Other api modules import only this file.
 */
export { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer, type EmailJobEnqueuer } from "./email-job.enqueuer";
export { EMAIL_QUEUE_NAME, emailJobEnqueuerFactory } from "./email-job-enqueuer.factory";
export { EmailModule } from "./email.module";
