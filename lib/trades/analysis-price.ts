import { isRichSnapshot } from "./snapshot";
import { pairs, type Trade, type TradePair } from "./types";

/** JPY-quoted pairs in this app: 1 pip = 0.01. */
export const JPY_PIP_SIZE = 0.01;

/** Closed trades needed before a group yields a directional insight (not a ranking claim). */
export const MIN_INSIGHT_SAMPLE_SIZE = 5;

/** Convert absolute price delta to pips for supported JPY pairs. */
export function priceDeltaToPips(pair: string, absPriceDelta: number): number | null {
  if (!pairs.includes(pair as TradePair) || !Number.isFinite(absPriceDelta) || absPriceDelta < 0) return null;
  return Math.round((absPriceDelta / JPY_PIP_SIZE) * 100) / 100;
}

/** Analysis reference price from snapshot (rich only). Pair mismatch / missing → null. */
export function analysisReferencePrice(trade: Trade): number | null {
  const snap = trade.analysisSnapshot;
  if (!snap || snap.pair !== trade.pair) return null;
  if (!isRichSnapshot(snap)) return null;
  const price = snap.analysisPrice ?? snap.marketPrice;
  return price !== null && Number.isFinite(price) ? price : null;
}

export function entryPriceDeltaPips(trade: Trade): number | null {
  const ref = analysisReferencePrice(trade);
  if (ref === null) return null;
  return priceDeltaToPips(trade.pair, Math.abs(trade.entryPrice - ref));
}
