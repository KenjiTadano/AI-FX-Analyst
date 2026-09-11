export function indicatorKey(name: string): string | null {
  const text = name.normalize("NFKC").toLowerCase().replace(/[-_]/g, " ");
  const rules: [string, RegExp][] = [
    ["inflation", /\b(cpi|consumer prices?|inflation rate|pce|personal consumption expenditures)\b|消費者物価/],
    ["employment", /\b(non\s?farm|payrolls?|unemployment|employment|wages?|earnings|claimant count)\b|雇用|賃金/],
    ["growth", /\b(gdp|gross domestic product)\b/],
    ["consumption", /\bretail sales\b/],
    ["survey", /\b(ism|pmi|purchasing managers|tankan)\b|短観/],
    ["policy", /\b(fomc|federal funds|rate decision|interest rate|policy rate|monetary policy|boj meeting|ecb meeting|boe meeting)\b|政策金利|日銀会合/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}
