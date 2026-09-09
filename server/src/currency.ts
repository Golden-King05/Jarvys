const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";

export interface CurrencyResult {
  amount: number;
  from: string;
  to: string;
  result: number;
  rate: number;
  date: string;
}

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

export async function convertCurrency(
  amount: number,
  from: string,
  to: string
): Promise<CurrencyResult | { error: string }> {
  const fromCode = from.trim().toUpperCase();
  const toCode = to.trim().toUpperCase();
  const params = new URLSearchParams({ amount: String(amount), from: fromCode, to: toCode });

  const res = await fetch(`${FRANKFURTER_URL}?${params}`);
  if (!res.ok) {
    return { error: `Currency lookup failed (${res.status}) — check the currency codes (e.g. USD, EUR, JPY)` };
  }
  const data = (await res.json()) as FrankfurterResponse;
  const result = data.rates[toCode];
  if (result == null) {
    return { error: `No rate found for "${toCode}"` };
  }

  return { amount, from: fromCode, to: toCode, result, rate: result / amount, date: data.date };
}
