export type InvestmentProvider = "crypto_address" | "coinbase" | "etoro" | "manual_metal";

export interface InvestmentBalance {
  asset: string;
  quantity: number | null;
  value_amount: number;
  value_currency: string;
}
