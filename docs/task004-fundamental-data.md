# Task004 実装報告

作業ブランチ: `feature/task004-fundamental-data`。調査日: 2026-09-08。

「マーケット材料」を追加し、ニュース・経済指標・中央銀行・市場環境を独立したデータとして扱えるようにしました。AIの最終判断・注文処理は実装していません。Task003の為替／OHLC／テクニカル取得コードは変更していません。コミット・pushは行っていません。

## 採用APIと選定理由

FinnhubのMarket News (`/news?category=forex`) とEconomic Calendar (`/calendar/economic`) を採用。JSON/HTTPで取得でき、ヘッダー認証が使えるため、追加SDKなしでNext.jsのサーバー側に隔離できます。ニュースと経済指標を同一サービスにまとめ、既存のTwelve Dataと合わせて2サービスに抑えました。

- ニュース: 無料プランは月額0ドル、60 API calls/分。Forexカテゴリを取得し、USD・JPY・EUR・GBP、中央銀行名、国名などで対象通貨との関連性を分類します。各国・言語の網羅性は保証されず、記事が英語の場合は原文を表示します。
- 経済指標: Premium。Economic-1は月額50ドル相当、四半期払い、150 API calls/分。無料カレンダーとして扱わず、初期設定では無効にしました。購入・契約は行っていません。
- 地域: ニュースは世界のFXフィードから通貨を分類。カレンダーはUS/JP/GB/EU等の国・地域コードをUSD/JPY/GBP/EURへ正規化します。個別指標の掲載範囲は配信と契約に依存し、全指標取得を保証しません。
- 利用条件: 個人利用プラン。商用・再配布・データや派生結果の第三者共有にはFinnhubの書面承認が必要です。Task005で外部AIサービスへデータを送信する前に、その用途の許諾も確認してください。今回、外部AIへの送信はありません。

参照: [Market News仕様](https://finnhub.io/docs/api/market-news)、[Economic Calendar仕様](https://finnhub.io/docs/api/economic-calendar)、[無料枠](https://finnhub.io/pricing)、[経済データ料金](https://finnhub.io/pricing-economic-data-api)、[利用条件](https://finnhub.io/terms-of-service)。

比較した候補:

- Alpha Vantage: FOREXを含むニュース検索に対応。ただし通常の無料枠は25回/日で、5〜15分更新を終日続けるには不足します。ニュース用に追加する利点が小さいため不採用。[仕様](https://www.alphavantage.co/documentation/)、[無料枠](https://www.alphavantage.co/support/)、[個人・非商用条件](https://www.alphavantage.co/terms_of_service/)
- Trading Economics: 日本・米国・欧州・英国を含む広いカレンダーと実績／予想データが強み。確認したStandardは月199ドル・500リクエスト/月で、このMVPには費用と更新回数の面で不向き。配布用途で料金が変わります。[料金](https://tradingeconomics.com/api/pricing.aspx)、[API概要](https://tradingeconomics.com/analytics/api.aspx)
- FMP: 無料枠250回/日。ニュース・グローバル範囲・各エンドポイントのプラン制約、表示利用の別契約を考慮し、今回はFinnhubを選択しました。無料枠で必要な世界の経済指標カレンダーが使えるとは確認できていません。[公式料金・ライセンス](https://site.financialmodelingprep.com/developer/docs/pricing)

価格・権限は契約前に公式ページで再確認してください。

## 取得できるデータと未取得項目

接続実装済み:

- ニュース: タイトル、配信元の概要（ない場合null）、出典、公開日時、元記事URL、関連通貨、重要度。
- カレンダー（有料権限と有効化が必要）: 指標名、国／通貨、発表時刻、前回値、予想、実績、単位、重要度、主要指標フラグ。
- 中央銀行: Fed/BOJ/ECB/BOEの対応、関連ニュースID、取得済みカレンダー内の日時が確認できる金融政策会合候補。
- 通貨別要因: 各通貨に紐づくニュースID・指標ID・中央銀行。売買方向は未評価。

未取得:

- 現行政策金利、政策方向（利上げ・利下げ・据え置き）、市場全体のrisk-on/off、通貨別bullish/bearish。すべてnull／unavailable。カレンダーの予想金利を現在の政策金利に流用していません。
- APIキーが未設定のため、現環境でのFinnhub実データ取得成功は未検証です。カレンダーの有料権限も未確認です。
- 無料での世界の予想値付きカレンダー取得、日本語翻訳、リアルタイム速報、履歴保存、完全な中央銀行会合一覧。

## 日時・分類の扱い

日時はオフセットが確認できればISO UTCへ正規化し、UIではJST表示します。Finnhubの公開カレンダースキーマにはオフセットなし日時のタイムゾーンが明記されていないため、既定では `scheduledAt=null` と元の `rawScheduledAt` を保持します。UIにも「時刻基準未確認」と表示します。利用フィードがUTCであることを確認した場合のみ `FINNHUB_CALENDAR_TIMEZONE=UTC` を設定できます。

実績がある場合は `released`、未来の確定日時なら `upcoming`、予定時刻を過ぎても実績がなければ `awaiting_actual`、日時を判定できなければ `unknown`。単に時刻を過ぎただけでは発表済みにしません。0と負数も有効な実績として保持します。

ニュースの重要度は語句による表示優先度で、`importanceBasis=keyword` を明示。経済指標は配信元の重要度を優先し、なければ語句分類。関連通貨のキーワード分類には漏れ・誤検出があり、影響を断定するものではありません。`impactDirection=null` と `reason` に分類の根拠と限界を保持します。

## キャッシュ・障害分離

- Twelve Data: Task003のレート60秒、OHLC5分を維持。
- ニュース: 10分。全通貨ペアで同じForexフィードを共有。
- カレンダー: 30分。前日〜7日先を1回取得し、通貨ごとに絞り込み。providerの `calendarTtlMs` を差し替えて将来の重要発表付近の更新間隔を設定可能。現時点では動的短縮はしません。
- 同時リクエストは共有し、重複した外部API呼び出しを抑制。非表示タブは新しい要求を止め、表示中はローカルAPIを60秒ごとに確認します。外部APIはTTLで制御。
- 通信失敗・429・不正形式は60秒、401/403は15分待機してから再試行。外部通信は10秒で打ち切ります。
- 失敗時は古い成功値やモックへ置き換えず、`data=null` とエラー表示にします。空の正常結果とは区別します。
- ニュース／カレンダー、中央銀行／市場環境を `Promise.allSettled` で隔離。マーケットAPIと別の取得フローなので、一部障害で既存レート／テクニカルを落としません。
- キャッシュは単一Nodeプロセス内・最大8エントリー。再起動で消失します。複数インスタンスへ展開する場合は共有キャッシュ・共有レート制御が必要です。

## 環境変数と秘密情報

`.env.example` に `FINNHUB_API_KEY=`、`FINNHUB_CALENDAR_ENABLED=false`、`FINNHUB_CALENDAR_TIMEZONE=` を追加。実キーは `.env.local` にだけ設定し、変更後は再起動してください。既存 `.env.local` は変更していません。

認証キーはサーバー限定エントリーからHTTPヘッダーへ渡し、URL、APIレスポンス、エラーメッセージには含めません。取得先は固定。リダイレクトを許可せず、上流例外の本文は転送しません。`.env.local` がGitの除外対象であることを確認済みです。

## Task005へ渡す構造

`GET /api/fundamental?symbol=USD%2FJPY` が `FundamentalData` を返します。EUR/JPYとGBP/JPYも同じ形式です。対応外シンボルは400。

- `schemaVersion: 1`, `symbol`, `baseCurrency`, `quoteCurrency`, `generatedAt`
- `news`, `calendar`, `centralBanks`, `sentiment`: `data/status/provider/fetchedAt/error/warnings` を持つ個別リソース。
- ニュース・指標: `affectedCurrencies`, `importance`, `importanceBasis`, `impactDirection`, `reason`。
- `factors`: 通貨ごとのニュース・指標ID参照と中央銀行。
- `Observation<T>`: `value`, `availability`, `asOf`, `source`, `reason`。未取得と中立を明確に分離。

Task005では同じsymbolの既存 `MarketData` とこの `FundamentalData` を統合できます。providerは `FundamentalProviders` インターフェースで交換できます。今回AIの最終判断処理はありません。将来AIへ渡すニュース本文は外部の未信頼データとして扱い、記事内の指示を実行させず、出典・取得時刻・欠損状態も一緒に渡す設計を推奨します。

## UIと検証結果

既存の濃紺カード・文字色・余白を維持。「重要ニュース」「経済指標」「中央銀行」「市場環境」の4カテゴリを追加。ニュース・指標は最初の3件を表示し、残りと概要は折りたたみ。既存の架空の判断理由にも「モック」を明記しました。

- `npm run lint`: 成功。
- `npm run build`: 成功。TypeScript検証・静的ページ生成・2つのAPIルートを確認。既存のRosetta性能警告のみ。
- `npm test`: 23件成功。既存のテストスクリプトはなかったため追加。正規化、null/0/負数、不正日時、URL、3通貨のフィルタ、重複要求、TTL、401/403/429/500、通信・タイムアウト例外、部分障害、会合候補、Task003指標計算を検証。
- ブラウザ: 3通貨切り替え、未設定時の個別表示、中央銀行の対応を確認。Twelve Dataのテクニカル実数値が継続表示されることを確認。
- 正常ニュース／カレンダーと503障害は、リポジトリ外の検証用サーバーでテスト専用データを注入して確認。実データ取得の成功確認とは区別しています。テスト値に `TEST FIXTURE` と表示し、アプリ本体に代替モックは追加していません。
- スマホ幅: ブラウザ実測375pxでスクリーンショット確認。ニュース／指標の長いタイトル・値・カードに横方向のはみ出しなし。
- ブラウザのJavaScriptエラーログなし。`git diff --check` 成功。

## 変更ファイル

既存ファイル:

- `.env.example`: 新しい環境変数と説明。
- `app/globals.css`: マーケット材料のレスポンシブスタイル。
- `components/dashboard/dashboard.tsx`: 新セクションの配置、Task004表示、モック範囲の注記。
- `components/dashboard/panels.tsx`: 判断理由のモック表示を明確化。
- `package.json`: `npm test` を追加。依存パッケージの追加なし。

新規ファイル:

- `app/api/fundamental/route.ts`
- `components/dashboard/fundamental.tsx`
- `lib/fundamental/types.ts`
- `lib/fundamental/classification.ts`
- `lib/fundamental/normalize.ts`
- `lib/fundamental/resource.ts`
- `lib/fundamental/cache.ts`
- `lib/fundamental/providers/finnhub.ts`
- `lib/fundamental/central-banks.ts`
- `lib/fundamental/sentiment.ts`
- `lib/fundamental/service.ts`
- `lib/fundamental/client.ts`
- `scripts/test.mjs`
- `tests/fundamental.test.ts`
- `tsconfig.test.json`
- `docs/task004-fundamental-data.md`

`lib/market/*`、`app/api/market/route.ts`、`components/dashboard/market.tsx` に差分なし。
