// Self-service account registration + admin approval. Passwords are never
// stored in plain text: PBKDF2-SHA256 with a random per-user salt and a
// high iteration count, both computed with the Workers runtime's native
// Web Crypto - no external dependency.
import type { Env } from "./types";

const PBKDF2_ITERATIONS = 150_000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveHash(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt);
  return { hash, salt: bytesToBase64(salt) };
}

export async function verifyPassword(password: string, hash: string, saltB64: string): Promise<boolean> {
  const salt = base64ToBytes(saltB64);
  const candidate = await deriveHash(password, salt);
  return timingSafeEqual(candidate, hash);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function createUser(env: Env, email: string, password: string) {
  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, status) VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(id, email.trim().toLowerCase(), hash, salt)
    .run();
  return id;
}

export async function getUserByEmail(env: Env, email: string) {
  return env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email.trim().toLowerCase()).first<{
    id: string;
    email: string;
    password_hash: string;
    password_salt: string;
    status: string;
  }>();
}

export async function getUserById(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<{
    id: string;
    email: string;
    status: string;
  }>();
}

export async function listPendingUsers(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at ASC`
  ).all();
  return results;
}

export async function setUserStatus(env: Env, id: string, status: "approved" | "rejected") {
  await env.DB.prepare(
    `UPDATE users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END WHERE id = ?`
  )
    .bind(status, status, id)
    .run();
}
