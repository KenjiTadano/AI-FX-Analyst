import {
  marketRegimeForPair,
  sanitizeMarketRegimeAnalysis,
  type MarketRegimeAnalysis,
} from "../market/market-regime";
import type { MarketData, Symbol } from "../market/types";
import { pairs, type Trade, type TradePair } from "./types";

export const REGIME_SNAPSHOT_TITLE = "エントリー時の相場環境";
export const REGIME_SNAPSHOT_EYEBROW = "MARKET REGIME";
export const REGIME_SNAPSHOT_NOTE =
  "取引登録時に保存された1時間足の相場環境です。現在の市場や取引結果では再評価していません。";
export const REGIME_SNAPSHOT_MISSING = "相場環境は保存されていません";
export const REGIME_SNAPSHOT_UNREADABLE = "エントリー時の相場環境は確認できません";
export const REGIME_SNAPSHOT_DISCLAIMER = "1時間足の確定足から計算した市場状態です。売買の推奨ではありません。";

export type RegimeSnapshotState = "ok" | "absent" | "unreadable";

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Copy the live Dashboard Regime summary. No extra fetch, no candles, no Action. Pair mismatch → null. */
export function captureMarketRegimeSnapshot(
  market: MarketData | null | undefined,
  pair: string,
  analyzedAt: string,
): MarketRegimeAnalysis | null {
  if (!pairs.includes(pair as TradePair)) return null;
  const sanitized = sanitizeMarketRegimeAnalysis(
    marketRegimeForPair(market, pair as Symbol, analyzedAt),
    pair as Symbol,
  );
  return sanitized ? copy(sanitized) : null;
}

export function storedMarketRegimeAnalysis(trade: Trade): MarketRegimeAnalysis | null {
  const snap = trade.analysisSnapshot;
  if (!snap || !("version" in snap) || snap.version !== 1) return null;
  return sanitizeMarketRegimeAnalysis(snap.marketRegimeAnalysis, trade.pair as Symbol);
}

export function regimeSnapshotState(trade: Trade): RegimeSnapshotState {
  if (storedMarketRegimeAnalysis(trade)) return "ok";
  const snap = trade.analysisSnapshot;
  if (!snap || !("version" in snap) || snap.version !== 1) return "absent";
  return snap.marketRegimeAnalysis != null ? "unreadable" : "absent";
}
