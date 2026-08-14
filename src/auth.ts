// Two ways into this app:
//  - the owner logs in with APP_PASSWORD, same as before - this is the
//    "admin" session and it's what can approve/reject new accounts.
//  - anyone else registers with email + password, lands in 'pending', and
//    can only log in (as a regular, non-admin session) once the admin
//    approves them from Settings.
// Both end up as an opaque session token in KV; the session record says
// which kind it is.
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";
import { getUserByEmail, verifyPassword } from "./users";

const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionInfo {
  admin: boolean;
  userId?: string;
  email?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

async function createSession(c: Context<{ Bindings: Env }>, info: SessionInfo): Promise<void> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await c.env.KV.put(`session:${token}`, JSON.stringify(info), { expirationTtl: SESSION_TTL_SECONDS });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function loginAdmin(c: Context<{ Bindings: Env }>, password: string): Promise<boolean> {
  if (!c.env.APP_PASSWORD || !timingSafeEqual(password, c.env.APP_PASSWORD)) return false;
  await createSession(c, { admin: true });
  return true;
}

export async function loginUser(
  c: Context<{ Bindings: Env }>,
  email: string,
  password: string
): Promise<"ok" | "invalid" | "pending" | "rejected"> {
  const user = await getUserByEmail(c.env, email);
  if (!user) return "invalid";
  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return "invalid";
  if (user.status === "pending") return "pending";
  if (user.status === "rejected") return "rejected";
  await createSession(c, { admin: false, userId: user.id, email: user.email });
  return "ok";
}

export async function logout(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.KV.delete(`session:${token}`);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function getSession(c: Context<{ Bindings: Env }>): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const raw = await c.env.KV.get(`session:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionInfo;
  } catch {
    return null;
  }
}

export async function isAuthenticated(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return (await getSession(c)) !== null;
}

export async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const session = await getSession(c);
  return session?.admin === true;
}
