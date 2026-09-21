// Shared session/navigation plumbing (imported by screens and App alike).
import { createContext, useContext, useEffect, useState } from "react";
import type { AuthInfo } from "./api";

export function go(path: string) {
  if ((window.location.hash || "#/") === `#${path}`) window.scrollTo(0, 0);
  else window.location.hash = `#${path}`;
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => { setHash(window.location.hash || "#/"); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const path = pathPart.startsWith("/") ? pathPart : "/";
  return { path, query: new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "") };
}

export interface AuthContextValue {
  auth: AuthInfo | null;
  signIn: (info: AuthInfo) => void;
  signOut: () => void;
}
export const AuthContext = createContext<AuthContextValue>({ auth: null, signIn: () => {}, signOut: () => {} });
export function useAuth() { return useContext(AuthContext); }
