// eToro launched a public API (public-api.etoro.com) with genuinely
// scoped API keys - a "Read" permission key (x-api-key + x-user-key)
// cannot place, change, or cancel orders, only view portfolio data.
//
// Important honesty note: eToro's API docs portal wasn't reachable from
// this environment to verify the exact portfolio/balance endpoint path
// and response shape, so this adapter does not fabricate a guessed
// response. Credentials are still accepted, validated to be a read-only
// key type where possible, and stored encrypted - connecting is safe and
// "simple" as requested - but live balance sync is intentionally left
// unimplemented rather than risk showing you wrong numbers. Once you've
// generated a Read-only key and tried connecting, whatever error comes
// back can be used to wire up the real endpoint quickly.
import type { InvestmentBalance } from "./types";

export interface EtoroCreds {
  apiKey: string;
  userKey: string;
}

export async function syncEtoro(_creds: EtoroCreds): Promise<InvestmentBalance[]> {
  throw new Error(
    "eToro balance sync isn't wired up to a verified endpoint yet - your read-only key is saved, but this needs one more step to confirm against eToro's real API response."
  );
}
