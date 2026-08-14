// Thin client for the GoCardless "Bank Account Data" API (formerly Nordigen).
// This is a PSD2 Open Banking aggregator: you never see or store the user's
// bank password. The user authenticates directly with their bank via a
// redirect ("link"), and we only ever receive:
//   - our own API access token (secret_id/secret_key -> short-lived bearer token)
//   - read-only requisition/account identifiers and financial data
//
// Docs: https://developer.gocardless.com/bank-account-data/overview
import type { Env } from "./types";

const BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";

async function gcFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(env);
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GoCardless ${init.method || "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

// Our own API credential is the only long-lived secret this app holds.
// The resulting access token is cached in KV and refreshed automatically.
async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.KV.get("gc:access_token");
  if (cached) return cached;

  const refresh = await env.KV.get("gc:refresh_token");
  if (refresh) {
    try {
      const res = await fetch(`${BASE_URL}/token/refresh/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh }),
      });
      if (res.ok) {
        const data: { access: string; access_expires: number } = await res.json();
        await env.KV.put("gc:access_token", data.access, {
          expirationTtl: Math.max(60, data.access_expires - 60),
        });
        return data.access;
      }
    } catch {
      // fall through to a fresh token/new/ call
    }
  }

  const res = await fetch(`${BASE_URL}/token/new/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ secret_id: env.GC_SECRET_ID, secret_key: env.GC_SECRET_KEY }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GoCardless token/new failed: ${res.status} ${body}`);
  }
  const data: {
    access: string;
    access_expires: number;
    refresh: string;
    refresh_expires: number;
  } = await res.json();

  await env.KV.put("gc:access_token", data.access, {
    expirationTtl: Math.max(60, data.access_expires - 60),
  });
  await env.KV.put("gc:refresh_token", data.refresh, {
    expirationTtl: Math.max(60, data.refresh_expires - 60),
  });
  return data.access;
}

export function listInstitutions(env: Env, country: string) {
  return gcFetch<
    Array<{ id: string; name: string; bic?: string; logo?: string; countries: string[] }>
  >(env, `/institutions/?country=${encodeURIComponent(country.toLowerCase())}`);
}

export function createAgreement(
  env: Env,
  opts: { institution_id: string; max_historical_days?: number; access_valid_for_days?: number }
) {
  return gcFetch<{ id: string }>(env, `/agreements/enduser/`, {
    method: "POST",
    body: JSON.stringify({
      institution_id: opts.institution_id,
      max_historical_days: opts.max_historical_days ?? 180,
      access_valid_for_days: opts.access_valid_for_days ?? 90,
      access_scope: ["balances", "details", "transactions"],
    }),
  });
}

export function createRequisition(
  env: Env,
  opts: { institution_id: string; agreement_id: string; reference: string; redirect: string }
) {
  return gcFetch<{ id: string; link: string }>(env, `/requisitions/`, {
    method: "POST",
    body: JSON.stringify({
      institution_id: opts.institution_id,
      agreement: opts.agreement_id,
      reference: opts.reference,
      redirect: opts.redirect,
      user_language: "EN",
    }),
  });
}

export function getRequisition(env: Env, id: string) {
  return gcFetch<{
    id: string;
    status: string;
    accounts: string[];
    institution_id: string;
  }>(env, `/requisitions/${id}/`);
}

export function getAccountDetails(env: Env, accountId: string) {
  return gcFetch<{
    account: { iban?: string; currency?: string; ownerName?: string; name?: string; product?: string };
  }>(env, `/accounts/${accountId}/details/`);
}

export function getAccountBalances(env: Env, accountId: string) {
  return gcFetch<{
    balances: Array<{
      balanceAmount: { amount: string; currency: string };
      balanceType: string;
    }>;
  }>(env, `/accounts/${accountId}/balances/`);
}

export function getAccountTransactions(env: Env, accountId: string) {
  return gcFetch<{
    transactions: {
      booked: Array<Record<string, any>>;
      pending?: Array<Record<string, any>>;
    };
  }>(env, `/accounts/${accountId}/transactions/`);
}
