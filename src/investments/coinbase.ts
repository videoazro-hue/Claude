// Coinbase's classic v2 API (api.coinbase.com/v2), authenticated with a
// user-generated API key/secret. Create this key in Coinbase under
// Settings -> API -> New API key, and pick the "View" (read-only)
// permission - it grants scopes like wallet:accounts:read and cannot
// trade, send, or withdraw. We only ever call GET /v2/accounts.
import type { InvestmentBalance } from "./types";

export interface CoinbaseCreds {
  apiKey: string;
  apiSecret: string;
}

export async function syncCoinbase(creds: CoinbaseCreds): Promise<InvestmentBalance[]> {
  const path = "/v2/accounts?limit=100";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = await hmacSign(creds.apiSecret, timestamp + "GET" + path);

  const res = await fetch(`https://api.coinbase.com${path}`, {
    headers: {
      "CB-ACCESS-KEY": creds.apiKey,
      "CB-ACCESS-SIGN": sign,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-ACCESS-VERSION": "2021-01-01",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coinbase ${res.status}: ${body || "check your API key/secret and that it has View access"}`);
  }
  const data: any = await res.json();

  const balances: InvestmentBalance[] = [];
  for (const acct of data.data ?? []) {
    const amount = Number(acct.balance?.amount ?? 0);
    if (!amount) continue; // Coinbase creates a $0 wallet for every asset it supports; skip empties
    balances.push({
      asset: acct.balance?.currency ?? "?",
      quantity: amount,
      value_amount: Number(acct.native_balance?.amount ?? amount),
      value_currency: acct.native_balance?.currency ?? acct.balance?.currency ?? "EUR",
    });
  }
  return balances;
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
