// Minimal password-gate + session cookie. This app is meant for exactly one
// user (you), so there's no user table — just a single shared APP_PASSWORD
// secret and opaque session tokens stored in KV.
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";

const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export async function login(c: Context<{ Bindings: Env }>, password: string): Promise<boolean> {
  if (!c.env.APP_PASSWORD || !timingSafeEqual(password, c.env.APP_PASSWORD)) return false;

  const token = crypto.randomUUID() + crypto.randomUUID();
  await c.env.KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return true;
}

export async function logout(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.KV.delete(`session:${token}`);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function isAuthenticated(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  const found = await c.env.KV.get(`session:${token}`);
  return found !== null;
}
