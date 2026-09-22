// Outbound provider hooks: email / SMS / push.
//
// The architecture is real but no provider is wired yet: each function reads
// its configuration from environment variables, and when the provider is
// absent it logs a warning and returns { sent: false, reason:
// "provider not configured" } instead of pretending a message went out.
// Wire a real client (e.g. nodemailer for SMTP, an SMS gateway SDK, web-push
// for push) at the marked TODOs once credentials exist. Never fake a send.

export interface SendResult {
  sent: boolean;
  reason?: string;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
  const { sendEmail: send } = await import("./email");
  const r = await send({ to, subject, text: body });
  return r.sent ? { sent: true } : { sent: false, reason: r.error ?? "provider not configured" };
}

export async function sendSms(_to: string, _body: string): Promise<SendResult> {
  const { SMS_PROVIDER_KEY } = process.env;
  if (!SMS_PROVIDER_KEY) {
    console.warn("[providers] sendSms skipped: SMS_PROVIDER_KEY not configured");
    return { sent: false, reason: "provider not configured" };
  }
  // TODO: wire a real SMS gateway client here.
  console.warn("[providers] sendSms: SMS key is configured but no gateway client is wired yet");
  return { sent: false, reason: "provider not configured" };
}

export async function sendPush(_userId: string, _title: string, _body: string): Promise<SendResult> {
  const { PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY } = process.env;
  if (!PUSH_VAPID_PUBLIC_KEY || !PUSH_VAPID_PRIVATE_KEY) {
    console.warn("[providers] sendPush skipped: PUSH_VAPID_* keys not configured");
    return { sent: false, reason: "provider not configured" };
  }
  // TODO: wire a real web-push client here (needs stored subscriber endpoints).
  console.warn("[providers] sendPush: VAPID keys are configured but no push client is wired yet");
  return { sent: false, reason: "provider not configured" };
}
