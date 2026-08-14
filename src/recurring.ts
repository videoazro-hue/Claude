// Detects recurring payments (standing orders, subscriptions, direct debits)
// by looking for the same payee + a stable amount repeating on a regular
// cadence within the synced transaction history.
//
// We do this instead of asking the bank for its literal "standing order"
// list because that concept (i) isn't exposed by GoCardless's aggregated
// API, and (ii) doesn't exist at all for PayPal/Klarna/Revolut-style
// accounts. Pattern detection over transactions works uniformly across
// every connected account.

export interface TxnForDetection {
  account_id: string;
  institution_name: string;
  booking_date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  description?: string | null;
  counterparty?: string | null;
}

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "yearly";

export interface RecurringItem {
  id: string;
  account_id: string;
  institution_name: string;
  label: string;
  cadence: Cadence;
  amount: number;
  currency: string;
  monthly_equivalent: number;
  occurrences: number;
  last_date: string;
  next_predicted_date: string;
  confidence: "high" | "medium";
}

export interface RecurringResult {
  items: RecurringItem[];
  totalsByCurrency: Record<string, { monthlyOut: number; monthlyIn: number }>;
}

const CADENCE_BUCKETS: Array<{ name: Cadence; min: number; max: number; days: number; perYear: number }> = [
  { name: "weekly", min: 5, max: 9, days: 7, perYear: 52 },
  { name: "biweekly", min: 12, max: 16, days: 14, perYear: 26 },
  { name: "monthly", min: 25, max: 35, days: 30, perYear: 12 },
  { name: "quarterly", min: 80, max: 100, days: 91, perYear: 4 },
  { name: "semiannual", min: 170, max: 195, days: 182, perYear: 2 },
  { name: "yearly", min: 350, max: 380, days: 365, perYear: 1 },
];

// Strips reference numbers / invoice IDs so the same payee groups together
// even when each transaction line has a unique trailing number.
function normalizeKey(t: TxnForDetection): string {
  const raw = (t.counterparty || t.description || "").toLowerCase();
  const cleaned = raw
    .replace(/[0-9]{3,}/g, " ")
    .replace(/\b(re|ref|rechnung|invoice|beleg|mandat|nr|no|order)\b\.?:?/gi, " ")
    .replace(/[^a-z0-9äöüß\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").slice(0, 4).join(" ");
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function detectRecurring(transactions: TxnForDetection[]): RecurringResult {
  const groups = new Map<string, TxnForDetection[]>();
  for (const t of transactions) {
    if (!t.booking_date || !Number.isFinite(t.amount)) continue;
    const key = t.account_id + "|" + normalizeKey(t);
    if (key.endsWith("|")) continue; // nothing usable to group on
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const items: RecurringItem[] = [];

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.booking_date.localeCompare(b.booking_date));

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].booking_date, sorted[i].booking_date));
    const medGap = median(gaps);
    const bucket = CADENCE_BUCKETS.find((b) => medGap >= b.min && medGap <= b.max);
    if (!bucket) continue; // gaps don't line up with a recognizable cadence

    const amounts = sorted.map((t) => t.amount);
    const meanAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    if (meanAmount === 0) continue;
    const maxDev = Math.max(...amounts.map((a) => Math.abs(a - meanAmount)));
    if (maxDev / Math.abs(meanAmount) > 0.2) continue; // amount too inconsistent to be a standing order/subscription

    const last = sorted[sorted.length - 1];
    const nextDate = new Date(new Date(last.booking_date).getTime() + bucket.days * 86400000)
      .toISOString()
      .slice(0, 10);

    const gapVariance = gaps.reduce((s, g) => s + (g - medGap) ** 2, 0) / gaps.length;
    const gapStddev = Math.sqrt(gapVariance);
    const confidence: RecurringItem["confidence"] =
      sorted.length >= 3 && gapStddev <= bucket.days * 0.25 ? "high" : "medium";

    const labelSource = last.counterparty || last.description || "Payment";
    const label = labelSource.replace(/\s+/g, " ").trim().slice(0, 60) || "Payment";

    items.push({
      id: key,
      account_id: last.account_id,
      institution_name: last.institution_name,
      label,
      cadence: bucket.name,
      amount: last.amount,
      currency: last.currency,
      monthly_equivalent: (last.amount * bucket.perYear) / 12,
      occurrences: sorted.length,
      last_date: last.booking_date,
      next_predicted_date: nextDate,
      confidence,
    });
  }

  items.sort((a, b) => a.next_predicted_date.localeCompare(b.next_predicted_date));

  const totalsByCurrency: Record<string, { monthlyOut: number; monthlyIn: number }> = {};
  for (const item of items) {
    const t = (totalsByCurrency[item.currency] ??= { monthlyOut: 0, monthlyIn: 0 });
    if (item.monthly_equivalent < 0) t.monthlyOut += item.monthly_equivalent;
    else t.monthlyIn += item.monthly_equivalent;
  }

  return { items, totalsByCurrency };
}
