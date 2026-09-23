// Focused verification for the v13 Brevo HTTPS email provider.
//
// Spins up a stub Brevo API server on localhost, points BREVO_API_URL at
// it, and asserts:
//   1. 201 from Brevo        -> { sent: true }, request carries the api-key
//                               header and the right sender/to/subject/body.
//   2. html in the message   -> htmlContent is forwarded.
//   3. 401 from Brevo        -> { sent: false } with Brevo's error message.
//   4. Brevo beats SMTP      -> with both set, the stub is hit (no SMTP
//                               connection is attempted).
//   5. No provider           -> { sent: false, error: "Email is not configured." }
//   6. emailConfigured()     -> true with key, false without.
//
// Run: bun scripts/verify-email-brevo.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

let stubStatus = 201;
let stubBody: unknown = { messageId: "stub-123" };
let lastRequest: { headers: Record<string, string | string[] | undefined>; body: string } | null = null;

function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        lastRequest = { headers: req.headers, body: raw };
        res.writeHead(stubStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stubBody));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v3/smtp/email` });
    });
  });
}

// Import AFTER env is not yet set — the module reads env lazily per call.
const email = await import("../server/src/email.ts");

const savedEnv = { ...process.env };
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearEmailEnv() {
  setEnv({
    BREVO_API_KEY: undefined, BREVO_SENDER_EMAIL: undefined, BREVO_API_URL: undefined,
    SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined,
    EMAIL_TEST_CAPTURE: undefined,
  });
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const { server, url } = await startStub();
try {
  // 1. Happy path -----------------------------------------------------------
  clearEmailEnv();
  setEnv({ BREVO_API_KEY: "test-key-123", BREVO_SENDER_EMAIL: "shop@example.com", BREVO_API_URL: url });
  stubStatus = 201; stubBody = { messageId: "stub-123" }; lastRequest = null;
  const r1 = await email.sendEmail({ to: "buyer@example.com", subject: "Hello", text: "plain body" });
  check("brevo 201 -> sent:true", r1.sent === true, JSON.stringify(r1));
  check("brevo request used api-key header", lastRequest?.headers["api-key"] === "test-key-123");
  const b1 = JSON.parse(lastRequest?.body ?? "{}");
  check("brevo sender email", b1.sender?.email === "shop@example.com", lastRequest?.body ?? "");
  check("brevo recipient", b1.to?.[0]?.email === "buyer@example.com");
  check("brevo subject", b1.subject === "Hello");
  check("brevo textContent", b1.textContent === "plain body");
  check("brevo no htmlContent when none given", b1.htmlContent === undefined);

  // 2. HTML forwarded --------------------------------------------------------
  stubStatus = 201; lastRequest = null;
  const r2 = await email.sendEmail({ to: "buyer@example.com", subject: "Hi", text: "t", html: "<b>h</b>" });
  const b2 = JSON.parse(lastRequest?.body ?? "{}");
  check("brevo html forwarded", r2.sent === true && b2.htmlContent === "<b>h</b>");

  // 3. Brevo error surfaces honestly ------------------------------------------
  stubStatus = 401; stubBody = { code: "unauthorized", message: "Invalid API key" }; lastRequest = null;
  const r3 = await email.sendEmail({ to: "buyer@example.com", subject: "x", text: "y" });
  check("brevo 401 -> sent:false", r3.sent === false, JSON.stringify(r3));
  check("brevo error message surfaced", (r3.error ?? "").includes("Invalid API key"), r3.error ?? "");

  // 4. Brevo wins over SMTP (stub hit, no SMTP dial attempted) -----------------
  stubStatus = 201; stubBody = { messageId: "stub-456" }; lastRequest = null;
  setEnv({ SMTP_HOST: "192.0.2.1", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p" }); // TEST-NET-1: unroutable
  const r4 = await email.sendEmail({ to: "buyer@example.com", subject: "x", text: "y" });
  check("brevo takes precedence over SMTP", r4.sent === true && lastRequest !== null, JSON.stringify(r4));

  // 5. Nothing configured ------------------------------------------------------
  clearEmailEnv();
  const r5 = await email.sendEmail({ to: "buyer@example.com", subject: "x", text: "y" });
  check("no provider -> sent:false", r5.sent === false, JSON.stringify(r5));
  check("no provider -> honest error", r5.error === "Email is not configured.", r5.error ?? "");

  // 6. emailConfigured() --------------------------------------------------------
  clearEmailEnv();
  check("emailConfigured() false when nothing set", (await email.emailConfigured()) === false);
  setEnv({ BREVO_API_KEY: "k", BREVO_SENDER_EMAIL: "shop@example.com", BREVO_API_URL: url });
  check("emailConfigured() true with brevo key", (await email.emailConfigured()) === true);

  // 7. Sender fallback chain: BREVO_SENDER_EMAIL > SMTP_FROM > SMTP_USER ------
  clearEmailEnv();
  setEnv({ BREVO_API_KEY: "k", BREVO_API_URL: url, SMTP_FROM: "from@example.com", SMTP_USER: "user@example.com" });
  stubStatus = 201; lastRequest = null;
  await email.sendEmail({ to: "a@b.c", subject: "s", text: "t" });
  check("sender falls back to SMTP_FROM", JSON.parse(lastRequest?.body ?? "{}").sender?.email === "from@example.com");
  clearEmailEnv();
  setEnv({ BREVO_API_KEY: "k", BREVO_API_URL: url, SMTP_USER: "user@example.com" });
  lastRequest = null;
  await email.sendEmail({ to: "a@b.c", subject: "s", text: "t" });
  check("sender falls back to SMTP_USER", JSON.parse(lastRequest?.body ?? "{}").sender?.email === "user@example.com");
  const cfgMissing = email.brevoConfig();
  clearEmailEnv();
  setEnv({ BREVO_API_KEY: "k", BREVO_API_URL: url });
  check("brevoConfig() null without any sender", email.brevoConfig() === null);
  void cfgMissing;
} finally {
  server.close();
  process.env = savedEnv;
}

console.log(`\n${pass}/${pass + fail} brevo email checks passed`);
process.exit(fail ? 1 : 0);
