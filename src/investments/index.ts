import type { Env } from "../types";
import { decryptSecret } from "../crypto";
import { syncCryptoAddress, type CryptoAddressConfig } from "./cryptoAddress";
import { syncCoinbase, type CoinbaseCreds } from "./coinbase";
import { syncEtoro, type EtoroCreds } from "./etoro";
import type { InvestmentBalance, InvestmentProvider } from "./types";

export * from "./types";

export interface InvestmentRow {
  id: string;
  provider: InvestmentProvider;
  config_json: string;
  secret_enc: string | null;
}

export async function syncInvestment(env: Env, row: InvestmentRow): Promise<InvestmentBalance[]> {
  const config = JSON.parse(row.config_json);
  switch (row.provider) {
    case "crypto_address":
      return syncCryptoAddress(config as CryptoAddressConfig);
    case "coinbase": {
      if (!row.secret_enc) throw new Error("Missing Coinbase credentials");
      const creds = JSON.parse(await decryptSecret(env, row.secret_enc)) as CoinbaseCreds;
      return syncCoinbase(creds);
    }
    case "etoro": {
      if (!row.secret_enc) throw new Error("Missing eToro credentials");
      const creds = JSON.parse(await decryptSecret(env, row.secret_enc)) as EtoroCreds;
      return syncEtoro(creds);
    }
    default:
      throw new Error(`Unknown investment provider: ${row.provider}`);
  }
}
