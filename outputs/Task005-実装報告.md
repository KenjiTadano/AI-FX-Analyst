# Task005 実装報告

実装日: 2026-09-08
対象: AI-FX-Analyst / feature/task005-ai-analysis

## 完了内容

既存ダッシュボードのAI総合判定・判断理由・取引シナリオを分析APIへ接続しました。数値計算と最終的な条件判定はTypeScript、材料の意味解釈と説明はOpenAIが担当します。コミット・pushは行っていません。

Task003の市場データ取得・テクニカル計算、Task004のファンダメンタル取得・表示のファイルに差分はありません。既存サービスを再利用し、障害を分析側に隔離しました。

## 変更ファイル

- `lib/ai/types.ts`: 入出力、材料、品質、シナリオ、障害の共通型。
- `lib/ai/technical.ts`: 確定足検証、SMA比較・傾き、RSI、モメンタム、ATR、方向スコア。
- `lib/ai/input.ts`: 既存データの構造化、根拠ID、鮮度・充足率、重要指標の時間判定。
- `lib/ai/openai.ts`: Responses API、System Prompt、厳密なJSON Schemaと応答検証。
- `lib/ai/engine.ts`: 材料統合、確信度、5段階判定、WAIT条件。
- `lib/ai/scenario.ts`: 条件付き価格帯・損切り・利確・RRの計算と検証。
- `lib/ai/service.ts`: 独立したデータ取得、キャッシュ、同時要求の集約、呼出上限。
- `lib/ai/client.ts`: サーバー限定の既存サービス接続・環境変数読込。
- `app/api/analysis/route.ts`: 3通貨対応の統一JSON API。
- `components/dashboard/ai-analysis.tsx`: 分析取得、通貨切替、期限切れ・障害表示、分析カード。
- `components/dashboard/dashboard.tsx`: 既存カードの接続切替。
- `app/globals.css`: 既存配色を使う分析表示とスマホ調整。
- `.env.example`: OpenAI設定例。実キーは含めていません。
- `tests/ai.test.ts`: 分析・API・キャッシュ・異常系の38テスト。
- `scripts/test.mjs`: 全TypeScriptテストと従来の市場データテストをまとめて実行。
- `outputs/Task005-実装報告.md`: 本報告。

## 分析アーキテクチャ

`GET /api/analysis?pair=USD%2FJPY` に対して、既存の市場・ファンダメンタルサービスをPromise.allSettledで取得します。取得できたデータをTypeScriptで検証・計算し、AnalysisInputに正規化してOpenAIへ送ります。応答検証後、サーバーがscore・confidence・signal・scenarioを決定します。UIは外部APIを直接呼びません。

入力はpair、currentRate、technicalAnalysis、fundamentalData、dataAvailability、timestamp、eventRisk。材料には根拠ID・カテゴリ・出典・観測時刻を持たせます。資金や個人情報、APIキーをAI入力に含めません。

## OpenAI API・モデル

Responses APIの `POST https://api.openai.com/v1/responses` をサーバーから使用します。既定モデルは `gpt-4.1-mini`。`text.format` のstrict JSON Schemaを指定し、出力トークン上限3,500、タイムアウト25秒、`store: false` としています。SDK追加はありません。

公式モデルページの標準料金は入力100万トークンあたり$0.40、出力$1.60。無料API枠を前提としません。料金は変更されるため利用時に確認してください。

- [GPT-4.1 mini公式仕様・料金](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [Structured Outputs公式仕様](https://developers.openai.com/api/docs/guides/structured-outputs)

環境変数は `OPENAI_API_KEY`、`OPENAI_ANALYSIS_MODEL`、`OPENAI_ANALYSIS_HOURLY_LIMIT`、`OPENAI_ANALYSIS_DAILY_LIMIT`。既定の呼出上限は同一プロセス全体で20回/時・100回/日です。キーを設定する場合はローカルの `.env.local` を使い、サーバーを再起動してください。今回、実キーの追加・変更はしていません。

## プロンプト・応答検証

テクニカル、ニュース、経済指標、中央銀行、市場環境を分けて評価します。未取得情報の推測補完、材料がないことの強気・弱気扱い、RSIだけの逆張り、急落だけの売り判断を禁止する方針です。材料の矛盾、追いかけエントリーの危険、待機の必要性を説明させます。

外部ニュース本文を信頼できないデータとして扱い、その中の指示には従わないよう指定します。必須項目、列挙値、文字数、0〜100のconfidence、5カテゴリの重複、根拠IDの存在とカテゴリ整合性を検証します。Missingカテゴリや根拠のない方向判定は拒否します。ただし、文章内容の事実性を機械検証だけで保証するものではありません。

## Score・confidence

各時間足のテクニカル評価は、価格対SMA20を15点、SMA20対75を20点、75対200を20点、各SMAの傾きを各10点、5本モメンタムを15点として方向を加減算します。15分足30%、1時間足40%、4時間足30%で統合します。欠損分を残った時間足へ再配分しません。RSIは過熱評価に分離します。

総合scoreはテクニカル70%に、AIが解釈したニュース最大10点、経済指標10点、中央銀行7点、市場環境3点を加え、整数の−100〜+100に制限します。材料の重要度high/medium/lowは1/0.6/0.3倍。unknownは0点です。

閾値は+60以上strong_buy、+20以上buy、−19〜+19wait、−20以下sell、−60以下strong_sell。ただし安全条件でWAITを優先し、confidenceが75未満なら強い判定は通常の買い・売りへ落とします。

confidenceはAI値・データ充足率・90の最小値から、矛盾時20点、RSI過熱時8点を減算します。AI未取得時は最大35。scoreとは独立し、勝率ではありません。

## Data Quality

テクニカル40%、ニュース20%、経済指標20%、中央銀行10%、市場環境10%の重みで充足率を算出し、各カテゴリにok/partial/missingと理由を返します。

新鮮な価格、時間足ごとの必要数値、記事、発表日時・前回・予想または実績、銀行の観測値・関連ニュース、市場環境の観測値を評価します。成功した空配信はpartialで、未取得を中立として補完しません。ニュース15分、経済指標60分などの鮮度条件を設けています。これは情報の充足率であり、予測精度ではありません。

## シナリオ・安全策

1時間足のATRと直近高安を使用します。Longは現在値より0.10〜0.25 ATR低い押し目帯、Shortは同じ幅だけ高い戻り帯を設定します。損切りは直近安値/高値と帯からの距離を考慮し、利確①は直近高値/安値、利確②はさらに0.75 ATR先です。

JPY小数3桁に丸めた後で、有限・正数、帯の順序、Long/Shortの価格関係、利確②の位置を検証します。RRは帯の不利な端で算出し、1.5未満または不正価格ならscenarioをnullにしてWAITにします。AIは価格を自由生成しません。

データ充足率60未満、confidence55未満、新鮮な市場情報不足、材料や時間足の矛盾、急変・大きな乖離、重要指標直前、重要指標の時刻不明、AIの待機提案もWAIT条件です。重要指標は実績未取得で発表30分前〜15分後を対象にします。WAIT中は取引価格を表示しません。

資金50,000円・目標100,000円は参考値と明示し、推奨数量は未算出です。シナリオがある場合のみ1,000通貨の想定損失を表示します。注文機能はありません。

## キャッシュ・障害

通貨ごとに正常分析5分、フォールバック60秒をキャッシュし、同時要求を1回にまとめます。重要指標の30分前に入る時点でキャッシュを失効させます。UIも期限切れ時にWAITへ戻し、シナリオを隠します。将来の大幅な価格変化に対する再分析にはrevision依存注入を用意していますが、価格変化の自動監視は未実装です。

キャッシュと呼出上限はメモリ内のため、複数プロセス間では共有せず再起動で消えます。外部公開時の全体利用制限には共有ストア等が必要です。

キー未設定、OpenAI障害・429・不正JSON・拒否・不完全応答・タイムアウトでは、テクニカル計算結果と理由を表示してWAITにします。キーや外部応答の生エラーを画面・ログへ出しません。取得元の一部障害でもダッシュボード全体を停止しません。

## 検証結果

最終変更後に実行しました。

- `npm run lint`: 成功。
- `npm test`: 61件成功、失敗0（追加AI38件、既存ファンダメンタル23件）。従来の `tests/market.mjs` も成功。
- `npm run build`: 成功。トップと3つのAPIルートを生成。Rosetta環境の性能注意メッセージのみ。
- `git diff --check`: 成功。`.env.local` はGit除外対象。Task003・Task004の既存取得/表示ファイルに差分なし。

追加テストでは5段階判定、欠損・古いデータ、異なる通貨、確定足検証、根拠ID、Long/Short価格関係、RR不足、矛盾、重要指標、AI障害、不正JSON、タイムアウト、3通貨の独立キャッシュ、同時要求、期限切れ、呼出上限を確認しました。

ブラウザでは実環境のOpenAIキー未設定によるWAITを確認しました。実OpenAIキーがないため、実APIの認証・応答品質・課金の確認は未実施です。

正常応答の画面は、リポジトリ外の一時サーバーで全外部通信を置き換えた、TEST FIXTURE表示の検証データで確認しました。USD/JPYのすごく売り・Short、EUR/JPYのすごく買い・Long、GBP/JPYの待機と非表示シナリオへ切り替わりました。実売買の分析結果ではありません。

デスクトップ表示と、390pxのiframe内（スクロールバーを除く実コンテンツ375px）でスマホ表示を確認しました。長い判定名の折返しを修正し、3通貨で横はみ出しなしを確認しました。ブラウザのviewport指定が反映されなかったためiframeで検証しており、実機タッチ操作は未検証です。

OpenAIの503を模擬したブラウザ確認では、WAIT・テクニカルのみ・シナリオなしを表示し、既存の為替・テクニカル・材料画面は維持されました。不正JSON・タイムアウト等は自動テストで確認しています。

## Task006への引継ぎ

AIAnalysisにはpair、signal、score、technicalScore、confidence、summary、factors、bullishReasons、bearishReasons、riskWarnings、scenario、dataQuality、currentRate、analyzedAt、expiresAt、decisionReasons、aiの状態を保持します。AnalysisResponseはsuccess/data/error/cachedで統一しています。

1. 実OpenAIキー設定後の疎通・日本語説明品質・トークン使用量を評価する。
2. 判定閾値やATR倍率を履歴データで検証する。現在の値はMVP用の固定ルールで、収益性を検証した戦略ではない。
3. Finnhubの契約範囲と、取得した記事・市場情報を外部AIへ渡せる利用条件を確認する。未取得の政策金利・市場センチメントは引き続き推測補完しない。
4. 大幅な価格変化の検知とrevision更新、分散キャッシュ・共有利用上限を必要に応じて実装する。
5. 将来の資金管理は口座資金・許容リスク・取引単位等を明示的に扱う。現時点の推奨数量は未算出。
6. 分析履歴や検証指標を保存する場合はプロンプト/モデル/ルールのバージョンも記録する。認証・DB・発注連携は今回未追加。
