// Physical holdings you tell it about directly (gold coins/bars, silver,
// etc.) - there's no "account" to connect at all here, so nothing to hack:
// you enter the quantity you hold, and only the market price is fetched
// live, from a free, unauthenticated spot-price API. If the quantity is
// ever wrong, that's a typo you made, not a data breach.
import type { InvestmentBalance } from "./types";

export type Metal = "XAU" | "XAG" | "XPT" | "XPD";

export interface ManualMetalConfig {
  metal: Metal;
  quantity: number; // in the unit below
  unit: "oz" | "g";
}

const METAL_NAMES: Record<Metal, string> = {
  XAU: "Gold",
  XAG: "Silver",
  XPT: "Platinum",
  XPD: "Palladium",
};

const GRAMS_PER_TROY_OUNCE = 31.1034768;

export async function syncManualMetal(config: ManualMetalConfig): Promise<InvestmentBalance[]> {
  if (!config.quantity || config.quantity <= 0) throw new Error("Quantity must be greater than 0");
  const pricePerOz = await fetchSpotPriceUsd(config.metal);
  const quantityOz = config.unit === "g" ? config.quantity / GRAMS_PER_TROY_OUNCE : config.quantity;
  return [
    {
      asset: config.metal,
      quantity: config.quantity,
      value_amount: quantityOz * pricePerOz,
      value_currency: "USD",
    },
  ];
}

// gold-api.com - free, no API key, no rate limit, covers XAU/XAG/XPT/XPD.
async function fetchSpotPriceUsd(metal: Metal): Promise<number> {
  const res = await fetch(`https://api.gold-api.com/price/${metal}`);
  if (!res.ok) throw new Error(`Spot price lookup failed (${res.status}) for ${METAL_NAMES[metal]}`);
  const data: any = await res.json();
  const price = Number(data.price);
  if (!price) throw new Error(`Spot price lookup returned no usable price for ${METAL_NAMES[metal]}`);
  return price;
}

export { METAL_NAMES };
