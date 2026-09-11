# AI-FX-Analyst 実装報告書
## FRED米国マクロ実績統合（Task009追記）

- 実装日: 2026-09-11
- リポジトリ: AI-FX-Analyst
- ブランチ: feature/task009-economic-calendar
- コミット / push: 未実施

---

## 1. 目的と結論

FRED APIを使い、米国の重要マクロ経済指標の「発表済み実績値」を取得し、以下へ統合した。

- ダッシュボード（マーケット材料）
- FundamentalData
- Task005 AI分析入力 / Prompt
- Data Quality

結論:

- EODHD Economic Calendarは維持した
- FREDはカレンダー代替ではなく、発表済みマクロ実績の補完Providerとして独立動作する
- 実測で EODHD calendar=error でも FRED macroeconomic=ok を確認した
- Task003〜Task009の既存機能を壊さない範囲で最小変更した
- lint / build / 全テスト成功

---

## 2. 実装サマリー

### やったこと

1. FRED専用Providerを追加（server-only）
2. 主要8指標のseriesを公式metadataで確認して採用
3. FundamentalDataへ `macroeconomic` を追加
4. UIに「米国マクロ」セクションを追加
5. AI evidence / Prompt / Data Qualityへ反映
6. ユニットテスト追加と実API疎通確認

### やらなかったこと

- FREDによる経済指標カレンダー代替
- 市場予想値の取得
- 未来の発表時刻取得
- AIによる経済指標未来値予測
- 自動売買 / 証券会社API
- 過去マクロのSupabase保存
- 大規模なTask005書き換え
- BOJ / ECB / BOE対応

---

## 3. 変更ファイル

### 新規

- `lib/fundamental/fred-series.ts`
- `lib/fundamental/providers/fred.ts`
- `components/dashboard/us-macro.tsx`
- `tests/fred.test.ts`

### 更新

- `lib/fundamental/types.ts`
- `lib/fundamental/service.ts`
- `lib/fundamental/client.ts`
- `lib/fundamental/cache.ts`
- `lib/ai/input.ts`
- `lib/ai/types.ts`
- `lib/ai/openai.ts`
- `components/dashboard/fundamental.tsx`
- `components/dashboard/ai-analysis.tsx`
- `app/globals.css`
- `.env.example`
- `tests/ai.test.ts`
- `outputs/Task009-実装報告.md`

※ Task009既存の経済カレンダー関連ファイルも同ブランチに存在するが、今回のFRED追記は上記が中心。

---

## 4. 環境変数

```text
FRED_API_KEY=
```

- `.env.local` に実キー設定済み（Git管理外）
- `NEXT_PUBLIC_` は付けない
- クライアントへは渡さない
- APIキーはログ・UI・レスポンスへ出さない

---

## 5. 採用series一覧（公式確認済み）

確認日: 2026-09-11（FRED series metadata API）

| 表示名 | series id | series title | native units | frequency | seasonal adjustment | 使用変換 |
|---|---|---|---|---|---|---|
| 米CPI（前年比） | CPIAUCSL | Consumer Price Index for All Urban Consumers: All Items in U.S. City Average | Index 1982-1984=100 | Monthly | Seasonally Adjusted | units=pc1 |
| 米Core CPI（前年比） | CPILFESL | Consumer Price Index for All Urban Consumers: All Items Less Food and Energy in U.S. City Average | Index 1982-1984=100 | Monthly | Seasonally Adjusted | units=pc1 |
| 米PCE（前年比） | PCEPI | Personal Consumption Expenditures: Chain-type Price Index | Index 2017=100 | Monthly | Seasonally Adjusted | units=pc1 |
| 米Core PCE（前年比） | PCEPILFE | Personal Consumption Expenditures Excluding Food and Energy (Chain-Type Price Index) | Index 2017=100 | Monthly | Seasonally Adjusted | units=pc1 |
| 米非農業部門雇用者数増減（NFP） | PAYEMS | All Employees, Total Nonfarm | Thousands of Persons | Monthly | Seasonally Adjusted | units=chg |
| 米失業率 | UNRATE | Unemployment Rate | Percent | Monthly | Seasonally Adjusted | lin |
| 米実質GDP成長率（前期比年率） | A191RL1Q225SBEA | Real Gross Domestic Product | Percent Change from Preceding Period | Quarterly | Seasonally Adjusted Annual Rate | lin |
| 米実効FF金利 | FEDFUNDS | Federal Funds Effective Rate | Percent | Monthly | Not Seasonally Adjusted | lin |

公式参照:
https://fred.stlouisfed.org/docs/api/fred/series_observations.html

---

## 6. 指標の定義（混同防止）

### CPI / Core CPI / PCE / Core PCE
- 指数値そのものは使わない
- FRED公式変換 `pc1` = Percent Change from Year Ago を使う
- UI名に「前年比」を明示

### NFP
- PAYEMSの総雇用者数（例: 159075千人）は使わない
- `units=chg` による前月差（例: +162 千人）を使う
- 自前差分計算ではなくFRED変換を利用

### Unemployment
- UNRATE の % 水準

### GDP
- GDPC1（水準）ではなく
- A191RL1Q225SBEA（前期比年率%）を使用

### Federal Funds
- Effective Federal Funds Rate（FEDFUNDS）を使用
- Target Range / Upper Bound / Lower Boundではない
- 表示名は「米実効FF金利」
- 「政策金利」と誤表現しない

---

## 7. データ取得設計

### latest / previous
- FRED observations APIを使用
- `sort_order=desc&limit=8`
- 有効な数値観測から latest と previous を作成

### 欠損値処理
- `"."` / 空文字 / 非有限値 → null
- NaNはUI・AIへ渡さない
- 無理なNumber変換をしない

### 鮮度
- `observationDate` を必ず保持
- 指標ごとの stale 判定あり
  - 月次: 45日超で stale
  - 四半期GDP: 120日超で stale
- UI/AIに観測日と stale を渡す

### キャッシュ
- 通常60分
- 既存 ResourceCache を再利用
- 同一プロセス内で8系列バッチを共有
- 失敗: 60秒
- 401/403: 15分

---

## 8. FundamentalData / Data Quality / AI統合

### FundamentalData
```ts
macroeconomic: DataResource<EconomicIndicatorValue[]>
```

- EODHD calendar と FRED macro は別管理
- 例: calendar=missing/error でも macroeconomic=ok を許可

### Data Quality
```text
macroeconomicData: OK | PARTIAL | MISSING
```

- 全主要指標取得 → OK
- 一部seriesのみ → PARTIAL
- 全失敗 / 未設定 → MISSING
- FRED欠損だけで必ずWAITにはしない
- 既存5カテゴリの加重スコアは維持

### AI Prompt / evidence
最低限渡すもの:

- indicator name
- latest value
- previous value
- unit
- observation date
- source=FRED
- stale

AIへの指示:

- FREDは発表済み実績
- 市場予想ではない
- 将来値ではない
- observationDateを確認する
- 古いデータを最新速報として扱わない
- latestとpreviousの差だけで売買方向を断定しない
- 金利・ニュース・テクニカル・経済カレンダーと統合して判断する

---

## 9. UI

マーケット材料内に「05 米国マクロ」を追加。

表示内容の例:

- 米CPI（前年比）最新 / 前回 / 対象期間 / 観測日 / FRED
- Core PCE
- 失業率
- 米実効FF金利
- NFP増減（千人・前月差）

誤解防止:

- 「最新ニュース」ではない
- 「市場予想」ではない
- 「速報値」ではない
- 「次回発表」ではない
- Economic Calendarとは明確に分離

通貨ペア:

- USD/JPY: 米国マクロを強調表示
- EUR/JPY / GBP/JPY: USD要因として共通参照（折りたたみあり）
- AI入力には全ペアで利用可能

---

## 10. 実API確認結果（秘密情報なし）

確認日: 2026-09-11  
結果: 全8指標 HTTP成功

| 指標 | latest | previous | 観測日 |
|---|---|---|---|
| 米CPI（前年比） | 3.30386 % | 3.46353 % | 2026-07-01 / 2026-06-01 |
| 米Core CPI（前年比） | 2.46652 % | 2.56579 % | 2026-07-01 / 2026-06-01 |
| 米PCE（前年比） | 3.70117 % | 3.71697 % | 2026-07-01 / 2026-06-01 |
| 米Core PCE（前年比） | 3.34414 % | 3.34361 % | 2026-07-01 / 2026-06-01 |
| NFP増減 | +162 千人 | +21 千人 | 2026-08-01 / 2026-07-01 |
| 失業率 | 4.1 % | 4.1 % | 2026-08-01 / 2026-07-01 |
| 実質GDP成長率 | 1.5 % | 2.1 % | 2026-04-01 / 2026-01-01 |
| 米実効FF金利 | 3.63 % | 3.63 % | 2026-08-01 / 2026-07-01 |

単位チェック:

- CPIを指数300台として「300%」表示していない
- NFPを総雇用者数として扱っていない
- FFを 0.0533% として誤表示していない

独立動作チェック:

- EODHDカレンダー: error（権限不足）
- FREDマクロ: ok（8件）

---

## 11. 検証結果

- npm run lint: 成功（警告0）
- npm test: 184件成功 / 失敗0
- npm run build: 成功
- git diff --check: 成功

ブラウザ確認:

- USD/JPY: 米国マクロ8件表示
- EUR/JPY / GBP/JPY: 米国マクロ表示、USD共通参照注記あり
- カレンダー失敗時もアプリ全体は継続
- スマホ幅でも既存レイアウト内で表示可能

---

## 12. 既知の制限

1. FREDは経済指標カレンダーの代替ではない
2. 市場予想・次回発表時刻は取得しない
3. 月次/四半期ラグにより stale 表示になる場合がある（意図的）
4. キャッシュは単一プロセス内のみ
5. Average Hourly Earnings / Retail Sales / Industrial Production は未追加
6. BOJ / ECB / BOE マクロは未対応

---

## 13. 今後の引継ぎ

### Task010候補
1. TE / Finnhubカレンダーの実権限確認と実イベント検証
2. 多インスタンス向け共有キャッシュ
3. historical snapshot のSupabase保存設計
4. 取引スナップショットへの directionSignal / action / マクロ証拠の拡張

### BOJ / ECB / BOE追加時
1. 各国の公式seriesをmetadataで確認してから採用する
2. country / currency / source を分離する
3. UIは地域別セクションを並列追加する
4. 指数・変化率・政策目標レンジの混同を避ける

---

## 14. ChatGPT向け一言まとめ

今回の実装は「FREDで米国マクロの発表済み実績を取り、カレンダーとは独立にダッシュボード・AI・Data Qualityへ渡す」もの。  
EODHDカレンダーが落ちてもFREDは動く。  
CPIは前年比、NFPは前月差、FFは実効金利として扱い、モックや推測値は使っていない。  
検証は lint / 184テスト / build / 実API / ブラウザまで完了。コミットは未実施。
