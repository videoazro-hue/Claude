// The safest possible "read-only" connection there is: a public wallet
// address (what your Ledger, or any wallet, holds funds at). We only ever
// look the address up on the public blockchain - no private key, seed
// phrase, password, or exchange login is ever involved, so there is
// nothing here an attacker could use to move funds even in the worst case.
// A public address mathematically cannot authorize a spend.
import type { InvestmentBalance } from "./types";

export interface CryptoAddressConfig {
  chain: "BTC" | "ETH";
  address: string;
}

const COINGECKO_IDS: Record<CryptoAddressConfig["chain"], string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
};

export async function syncCryptoAddress(config: CryptoAddressConfig): Promise<InvestmentBalance[]> {
  const quantity =
    config.chain === "BTC" ? await fetchBtcBalance(config.address) : await fetchEthBalance(config.address);
  const eurPrice = await fetchEurPrice(config.chain);
  return [
    {
      asset: config.chain,
      quantity,
      value_amount: quantity * eurPrice,
      value_currency: "EUR",
    },
  ];
}

// Blockstream's public Esplora API - no auth, no rate-limit key needed.
async function fetchBtcBalance(address: string): Promise<number> {
  const res = await fetch(`https://blockstream.info/api/address/${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Blockchain lookup failed (${res.status}) - check the address is a valid BTC address`);
  const data: any = await res.json();
  const sats =
    data.chain_stats.funded_txo_sum -
    data.chain_stats.spent_txo_sum +
    (data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum);
  return sats / 1e8;
}

// A public Ethereum JSON-RPC endpoint - eth_getBalance is a read call,
// again requiring no key or credential of any kind.
async function fetchEthBalance(address: string): Promise<number> {
  const res = await fetch("https://cloudflare-eth.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  if (!res.ok) throw new Error(`RPC lookup failed (${res.status}) - check the address is a valid ETH address`);
  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return Number(BigInt(data.result as string)) / 1e18;
}

async function fetchEurPrice(chain: CryptoAddressConfig["chain"]): Promise<number> {
  const id = COINGECKO_IDS[chain];
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eur`);
  if (!res.ok) throw new Error(`Price lookup failed (${res.status})`);
  const data: any = await res.json();
  return data[id]?.eur ?? 0;
}
