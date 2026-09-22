// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";
import type { ApiRequest } from "@hatch/space-sdk/client";

// --- Auth state -----------------------------------------------------------
// The signed-in session is kept in localStorage under this key. Every action
// call automatically attaches `authToken` when the caller did not pass one
// explicitly; unknown payload keys are ignored by the server's validation,
// so guest (signed-out) calls are unaffected.
export const AUTH_STORAGE_KEY = "nepalsite_auth";
export type AuthType = "buyer" | "seller" | "admin";
export interface AuthInfo {
  token: string;
  type: AuthType;
  name: string;
}

export function getAuth(): AuthInfo | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthInfo>;
    if (!parsed.token || !parsed.type || !parsed.name) return null;
    return { token: parsed.token, type: parsed.type, name: parsed.name };
  } catch {
    return null;
  }
}

export function setAuth(auth: AuthInfo): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

// Legacy seller sign-in (seller code + key, no token session) is kept for the
// original demo sellers. These credentials live in sessionStorage only.
const LEGACY_SELLER_KEY = "nepalsite_seller_legacy";
export interface LegacySeller {
  seller_code: string;
  seller_key: string;
}
export function getLegacySeller(): LegacySeller | null {
  try {
    const raw = sessionStorage.getItem(LEGACY_SELLER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LegacySeller>;
    if (!parsed.seller_code || !parsed.seller_key) return null;
    return { seller_code: parsed.seller_code, seller_key: parsed.seller_key };
  } catch {
    return null;
  }
}
export function setLegacySeller(creds: LegacySeller): void {
  sessionStorage.setItem(LEGACY_SELLER_KEY, JSON.stringify(creds));
}
export function clearLegacySeller(): void {
  sessionStorage.removeItem(LEGACY_SELLER_KEY);
}

const rawClient = createActionClient<typeof Actions>();

type RawClient = typeof rawClient;
export const api: RawClient = new Proxy(rawClient, {
  get(target, name, receiver) {
    const fn = Reflect.get(target, name, receiver) as unknown;
    if (typeof fn !== "function" || typeof name !== "string") return fn;
    return (args?: Record<string, unknown>) => {
      let merged = args;
      const auth = getAuth();
      if (auth?.token && args && typeof args === "object" && !("authToken" in args)) {
        merged = { ...args, authToken: auth.token };
      }
      return (fn as (a?: unknown) => unknown).call(target, merged);
    };
  },
});

// --- Admin SMTP settings (typed wrappers) ---------------------------------
// The signed-in admin session token is attached automatically by the proxy
// above when the caller does not pass authToken explicitly.
export function adminGetSmtpSettings(args: ApiRequest<typeof api, "adminGetSmtpSettings"> = {}) {
  return api.adminGetSmtpSettings(args);
}
export function adminSaveSmtpSettings(args: ApiRequest<typeof api, "adminSaveSmtpSettings">) {
  return api.adminSaveSmtpSettings(args);
}
export function adminSendTestSmtpEmail(args: ApiRequest<typeof api, "adminSendTestSmtpEmail">) {
  return api.adminSendTestSmtpEmail(args);
}

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
