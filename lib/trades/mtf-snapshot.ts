import {
  multiTimeframeForPair,
  sanitizeMultiTimeframeAnalysis,
  type MultiTimeframeAnalysis,
} from "../market/multi-timeframe";
import type { MarketData, Symbol } from "../market/types";
import { marketContextFromTrade } from "./market-context-snapshot";
import { pairs, type Trade, type TradePair } from "./types";

export const MTF_SNAPSHOT_TITLE = "エントリー時の市場構造";
export const MTF_SNAPSHOT_EYEBROW = "MTF SNAPSHOT";
export const MTF_SNAPSHOT_NOTE =
  "取引登録時に保存されたマルチタイムフレーム分析です。現在の市場や取引結果では再評価していません。";
export const MTF_SNAPSHOT_MISSING = "エントリー時のマルチタイムフレーム分析は保存されていません";
export const MTF_SNAPSHOT_UNREADABLE = "エントリー時のマルチタイムフレーム分析は確認できません";
export const MTF_SNAPSHOT_DISCLAIMER = "各時間軸は確定足のSMA並びから計算した市場状態です。売買の推奨ではありません。";

export type MtfSnapshotState = "ok" | "absent" | "unreadable";

/** Copy the live Dashboard MTF summary. No extra fetch, no candles, no Action. Pair mismatch → null. */
export function captureMultiTimeframeSnapshot(
  market: MarketData | null | undefined,
  pair: string,
  analyzedAt: string,
): MultiTimeframeAnalysis | null {
  if (!pairs.includes(pair as TradePair)) return null;
  return sanitizeMultiTimeframeAnalysis(
    multiTimeframeForPair(market, pair as Symbol, analyzedAt),
    pair as Symbol,
  );
}

/**
 * Read adapter: marketContextSnapshot (Task104) → legacy analysisSnapshot MTF.
 * Never recomputes from live market.
 */
export function storedMultiTimeframeAnalysis(trade: Trade): MultiTimeframeAnalysis | null {
  const independent = marketContextFromTrade(trade);
  if (independent?.multiTimeframe) return independent.multiTimeframe;
  const snap = trade.analysisSnapshot;
  if (!snap || !("version" in snap) || snap.version !== 1) return null;
  return sanitizeMultiTimeframeAnalysis(snap.multiTimeframeAnalysis, trade.pair);
}

export function mtfSnapshotState(trade: Trade): MtfSnapshotState {
  if (storedMultiTimeframeAnalysis(trade)) return "ok";
  const independent = marketContextFromTrade(trade);
  if (independent) return independent.multiTimeframe != null ? "unreadable" : "absent";
  const snap = trade.analysisSnapshot;
  if (!snap || !("version" in snap) || snap.version !== 1) return "absent";
  return snap.multiTimeframeAnalysis != null ? "unreadable" : "absent";
}
