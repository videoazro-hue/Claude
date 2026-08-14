export type InvestmentProvider = "crypto_address" | "coinbase" | "etoro";

export interface InvestmentBalance {
  asset: string;
  quantity: number | null;
  value_amount: number;
  value_currency: string;
}
