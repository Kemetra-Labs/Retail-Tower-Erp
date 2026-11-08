/**
 * RT-1280 — SesEmailAdapter with a fake SES client (no network, no AWS).
 */
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  EmailDeliveryError,
  SesEmailAdapter,
  type SesSendClient,
} from "../../src/email/ses-email.adapter";
import type { EmailMessage } from "../../src/email/email.adapter";

const FROM = "no-reply@example.test";
const TO = "invitee@example.test";
const RAW_TOKEN = "raw-token-zzzzzzzzzzzzzzzz";

class FakeSes implements SesSendClient {
  readonly commands: SendEmailCommand[] = [];
  failWith?: unknown;

  readonly signals: (AbortSignal | undefined)[] = [];

  async send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.commands.push(command);
    this.signals.push(options?.abortSignal);
    if (this.failWith !== undefined) throw this.failWith;
    return { MessageId: "m-1" };
  }
}

/** An SES call that never answers on its own; it settles only when aborted. */
class HangingSes implements SesSendClient {
  send(_command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    return new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason));
    });
  }
}

const MESSAGE: EmailMessage = {
  to: TO,
  subject: "Subject",
  textBody: `text ${RAW_TOKEN}`,
  htmlBody: `<p>html ${RAW_TOKEN}</p>`,
  tags: { template_id: "memberships.invitation" },
};

describe("SesEmailAdapter.send", () => {
  it("sends one SendEmail with the configured sender, recipient and UTF-8 bodies", async () => {
    const ses = new FakeSes();
    await new SesEmailAdapter(ses, FROM).send(MESSAGE);

    expect(ses.commands).toHaveLength(1);
    const input = ses.commands[0]!.input;
    expect(input.FromEmailAddress).toBe(FROM);
    expect(input.Destination?.ToAddresses).toEqual([TO]);
    expect(input.Content?.Simple?.Subject).toEqual({ Data: "Subject", Charset: "UTF-8" });
    expect(input.Content?.Simple?.Body?.Text).toEqual({ Data: MESSAGE.textBody, Charset: "UTF-8" });
    expect(input.Content?.Simple?.Body?.Html).toEqual({ Data: MESSAGE.htmlBody, Charset: "UTF-8" });
  });

  it("omits the HTML part when the message has none", async () => {
    const ses = new FakeSes();
    const { htmlBody: _html, ...textOnly } = MESSAGE;
    await new SesEmailAdapter(ses, FROM).send(textOnly);
    expect(ses.commands[0]!.input.Content?.Simple?.Body?.Html).toBeUndefined();
  });

  it("sanitizes tags to the characters SES accepts", async () => {
    const ses = new FakeSes();
    await new SesEmailAdapter(ses, FROM).send(MESSAGE);
    expect(ses.commands[0]!.input.EmailTags).toEqual([
      { Name: "template_id", Value: "memberships-invitation" },
    ]);
  });

  it("re-throws a failure as EmailDeliveryError without the recipient, token or SES message", async () => {
    const ses = new FakeSes();
    const sesError = Object.assign(
      new Error(`Email address is not verified. The following identities failed the check: ${TO}`),
      { name: "MessageRejected", $metadata: { httpStatusCode: 400 } },
    );
    ses.failWith = sesError;

    const promise = new SesEmailAdapter(ses, FROM).send(MESSAGE);
    await expect(promise).rejects.toBeInstanceOf(EmailDeliveryError);
    const err = (await promise.catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("SES SendEmail failed: MessageRejected (HTTP 400)");
    expect(err.message).not.toContain(TO);
    expect(err.message).not.toContain(RAW_TOKEN);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("passes an abort signal on every send", async () => {
    const ses = new FakeSes();
    await new SesEmailAdapter(ses, FROM).send(MESSAGE);
    expect(ses.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("fails a stalled send after the timeout instead of hanging the job", async () => {
    await expect(new SesEmailAdapter(new HangingSes(), FROM, 20).send(MESSAGE)).rejects.toThrow(
      "SES SendEmail failed: TimeoutError",
    );
  });

  it("maps a non-Error or odd error name to UnknownError", async () => {
    const ses = new FakeSes();
    ses.failWith = { name: `bad name ${TO}` };
    await expect(new SesEmailAdapter(ses, FROM).send(MESSAGE)).rejects.toThrow(
      "SES SendEmail failed: UnknownError",
    );
  });
});
