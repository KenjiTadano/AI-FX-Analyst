import type { Account, FxAnalysis } from "@/types/analysis";

export const mockAccount: Account = { balance: 50_000, target: 100_000 };

// Fixed demonstration snapshots. Replace this data source with an API adapter later.
export const mockAnalyses: FxAnalysis[] = [
  {
    pair: "USD/JPY", name: "米ドル / 日本円", quoteCurrency: "JPY", decimals: 3,
    rate: 153.555, changePercent: -0.62, asOf: "2026-09-08 09:00 JST",
    signal: "sell", score: 72, quoteToJpy: 1,
    trade: { direction: "sell", entry: 153.55, stopLoss: 154.10, takeProfit1: 153.00, takeProfit2: 152.50, units: 1_000 },
    reasons: [
      { category: "テクニカル", assessment: "売り", tone: "negative", summary: "下降トレンドが継続", detail: "短期・中期・長期の移動平均線が下向き。RSIは売られすぎ圏に接近。" },
      { category: "ニュース", assessment: "やや売り", tone: "negative", summary: "ドル売り材料が優勢", detail: "米景気の減速懸念を想定したサンプル。ドルの上値が重いシナリオ。" },
      { category: "経済指標", assessment: "注意", tone: "neutral", summary: "重要指標前の変動に注意", detail: "重要指標の発表を想定。発表前後は価格の急変とスプレッド拡大に注意。" },
      { category: "マクロ", assessment: "売り", tone: "negative", summary: "日米金利差の縮小を想定", detail: "米利下げ・日本の政策正常化を仮定した、円買い優勢のシナリオ。" },
    ],
    comment: "下降トレンドが続くシナリオです。ただし、RSIが売られすぎ圏に近いため、下落を追いかけず、戻りを確認してからの売りを想定しています。154.100を超えた場合はシナリオを見直し、重要指標の前後は新規エントリーを慎重に判断します。",
  },
  {
    pair: "EUR/JPY", name: "ユーロ / 日本円", quoteCurrency: "JPY", decimals: 3,
    rate: 169.820, changePercent: 0.34, asOf: "2026-09-08 09:00 JST",
    signal: "buy", score: 65, quoteToJpy: 1,
    trade: { direction: "buy", entry: 169.80, stopLoss: 169.20, takeProfit1: 170.40, takeProfit2: 171.00, units: 1_000 },
    reasons: [
      { category: "テクニカル", assessment: "買い", tone: "positive", summary: "短期の上昇基調", detail: "短期移動平均線が中期線を上回り、押し目形成を想定。" },
      { category: "ニュース", assessment: "やや買い", tone: "positive", summary: "ユーロを支える材料", detail: "欧州景気の底堅さを仮定したサンプルシナリオ。" },
      { category: "経済指標", assessment: "注意", tone: "neutral", summary: "欧州指標を確認", detail: "指標の結果次第で上昇シナリオが変わる可能性を想定。" },
      { category: "マクロ", assessment: "中立", tone: "neutral", summary: "金利見通しは交錯", detail: "欧州と日本の政策見通しが拮抗するシナリオ。" },
    ],
    comment: "短期的には買い優勢を想定しています。169.800付近の押し目と反発を確認するシナリオです。169.200を下回れば見直し、目標価格では段階的な利益確定を想定します。",
  },
  {
    pair: "GBP/JPY", name: "英ポンド / 日本円", quoteCurrency: "JPY", decimals: 3,
    rate: 201.240, changePercent: -0.08, asOf: "2026-09-08 09:00 JST",
    signal: "wait", score: 48, quoteToJpy: 1, trade: null,
    reasons: [
      { category: "テクニカル", assessment: "中立", tone: "neutral", summary: "方向感のないレンジ", detail: "移動平均線が横ばい。明確なブレイクを待つ想定。" },
      { category: "ニュース", assessment: "中立", tone: "neutral", summary: "材料が交錯", detail: "売り・買い材料が拮抗するサンプルシナリオ。" },
      { category: "経済指標", assessment: "注意", tone: "neutral", summary: "英国指標の結果待ち", detail: "指標発表後の方向性を確認してから再評価する想定。" },
      { category: "マクロ", assessment: "中立", tone: "neutral", summary: "政策見通しが不透明", detail: "英日双方の金利見通しに確信が持てないシナリオ。" },
    ],
    comment: "売りと買いの根拠が拮抗しているため、今回は待ったの判定です。新規ポジションは想定せず、レンジを抜けて方向性が明確になるまで様子を見ます。",
  },
];
