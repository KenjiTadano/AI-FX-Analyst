# Task009 経済指標カレンダー強化 実装報告

実装日：2026-09-11。対象リポジトリ：`/Users/tadanokenji/dev/AI-FX-Analyst`。ブランチ：`feature/task009-economic-calendar`。コミット・pushは行っていません。

経済指標の取得・正規化、発表前後の待機制御、次回重要イベント、前回／市場予想／実績／比較可能な差分を実装しました。市場データ、ニュース、リスク計算、取引記録、Supabaseの既存機能は維持しています。

今回、EODHD Economic Events providerを追加し、`EODHD_API_TOKEN`がある場合は最優先でサーバーから取得します。今回渡されたトークンで2026-09-11〜2026-09-18を実API疎通したところ、US・JP・GB・EUの全リクエストがHTTP 401でした。したがって実データの表示・国コード・actualの到着状態はこの契約では確認できず、実データをモックで補完していません。認証エラーはEconomic Calendarだけをerror状態にし、市場画面全体は継続します。

## 変更ファイル

以下はリポジトリルートからの相対パスです。

- `lib/economic-calendar/provider.ts`：共通Providerインターフェース。
- `lib/economic-calendar/trading-economics.ts`：Trading Economics REST取得。
- `lib/economic-calendar/providers/eodhd.ts`：EODHD Economic Events REST取得、国別リクエスト、HTTPエラー分類、30分キャッシュ。
- `lib/economic-calendar/eodhd-normalize.ts`：EODHDの`type/country/date/actual/estimate/previous`を共通EconomicEventへ正規化。
- `lib/economic-calendar/service.ts`：Finnhubへのfallback。
- `lib/economic-calendar/classification.ts`：指標名称の分類。
- `lib/economic-calendar/normalize.ts`：Trading Economics正規化とsurprise。
- `lib/economic-calendar/risk-window.ts`：待機時間帯、次回high、残り時間、JST表示、TTL方針。
- `lib/fundamental/types.ts`：既存EconomicEvent型の拡張。
- `lib/fundamental/normalize.ts`：Finnhubも共通指標分類を使用。
- `lib/fundamental/cache.ts`：取得内容に応じたTTL対応。
- `lib/fundamental/providers/finnhub.ts`：発表時刻に応じたTTLを適用。
- `lib/fundamental/client.ts`：Provider選択の接続。
- `lib/ai/types.ts`、`input.ts`、`engine.ts`、`openai.ts`：リスク・入力・行動・プロンプト連携。
- `components/dashboard/economic-calendar.tsx`：カレンダーカードと上部イベント案内。
- `components/dashboard/fundamental.tsx`、`dashboard.tsx`：取得結果を共有し、カレンダー表示を組み込み。
- `components/dashboard/ai-analysis.tsx`：相場方向と現在の行動を別表示。
- `app/globals.css`、`.env.example`：表示調整とキーの空欄追加。
- `tests/economic-calendar.test.ts`：Task009追加37件。EODHDのnull値、HTTP 401/403/429/5xx、国別取得、秘密情報非表示を追加。
- `tests/ai.test.ts`：実績取得後もリスク時間帯を維持する仕様に期待値を更新。
- `outputs/Task009-実装報告.md`：本報告。

ニュースの重要度分類は変更していません。経済指標だけの分類を独立させました。認証・Supabaseスキーマ、取引保存、資金計算の本体、既存市場APIは変更していません。

## 採用ProviderとAPI選定

EODHDを最優先Providerとして追加しました。公式仕様が示す`from/to/country/fmt=json`と、レスポンスの`type/country/date/actual/estimate/previous`を利用します。USD/JPY/GBPはUS/JP/GBを指定し、EURは`EODHD_EUR_COUNTRY`で契約上確認したコードを指定できます。未設定時の暫定値EUは警告付きで扱い、契約レスポンスで確認できるまで「実際に取得できたEuro Areaコード」とは報告しません。[EODHD Economic Events公式仕様](https://eodhd.com/financial-apis/economic-events-data-api)

Trading EconomicsはEODHD未設定時の次順位、Finnhubはそのfallbackとして残しました。EODHDが認証・権限・レート制限エラーを返した場合、別データで埋めずEconomic Calendarをエラー表示します。

既存Finnhubはfallbackとして残しました。Trading Economicsが未設定・権限不足・障害の場合、設定済みかつ利用可能なFinnhubカレンダーを使います。有効な空配列を取得した場合には別Providerを呼びません。両方取得不能なら未取得またはエラーです。Finnhubの既存EUR分類にはユーロ圏加盟国の指標も含まれ、国名／国コードを表示して区別します。

両Providerともサーバーから通常のfetchで利用し、新規SDKは不要です。UIから外部APIは呼ばず、既存`/api/fundamental`経由で表示します。

## API料金・無料枠・利用制限

EODHD公式仕様ではEconomic EventsはAll-In-One／Fundamentals Data Feedの対象で、1リクエスト1 API callです。EODHDの料金ページには無料枠として1日20 API callsの案内がありますが、Economic Eventsの利用権限はプラン・アカウントで異なるため、今回のトークンではHTTP 401となり無料枠の実利用可否を確認できません。[EODHD仕様](https://eodhd.com/financial-apis/economic-events-data-api)、[EODHD料金](https://eodhd.com/pricing)

Trading Economicsの公式料金ページでは、試用は有料・自動更新があり、試用上限は100リクエスト／100,000データポイントと案内されています。恒常的な無料カレンダー枠とは扱っていません。今回取得できた公式ページ本文では固定月額を確定できなかったため、金額は未確定です。[公式料金](https://tradingeconomics.com/api/pricing.aspx)

Trading Economicsは使用機能、リクエスト量、配信範囲で料金が変わります。商用表示・再配信は契約条件の確認が必要です。本アプリを動かすための有料契約を必須にはしていません。[公式API案内](https://tradingeconomics.com/api/)

公式の一般制限は2リクエスト/秒、カレンダーは1回最大1,000行です。本実装では上限に達した応答を不完全な可能性があるものとして拒否し、「イベントなし」とは表示しません。[公式Rate Limits](https://docs.tradingeconomics.com/get_started/rate-limits/)

Finnhub Economic CalendarはPremium対象として扱い、一般の無料APIキーだけで取得可能とは保証しません。現在の既存設定は無効です。カレンダーの具体的料金・対象国・商用権限はアカウントの契約内容で確認が必要です。今回公式料金画面の本文から料金額は取得できず、過去の価格を断定していません。[Finnhub公式APIドキュメント](https://finnhub.io/docs/api/quote)、[公式料金](https://finnhub.io/pricing)

## 取得項目・EconomicEvent型

Task004のEconomicEventを継続使用し、previous／forecast／actualを`number | string | null`へ拡張、updatedAtとindicatorKeyを追加しました。既存のid、currency、country、name、scheduledAt、rawScheduledAt、timezone、importance、source、url、isKeyIndicator、affectedCurrencies、impactDirection、reasonを維持します。

statusは互換性のため`upcoming / released / awaiting_actual / unknown`を継続使用します。発表時刻を過ぎただけでは「発表済み」にしません。actualが存在する場合のみreleased、時刻経過・actualなしはawaiting_actualです。0も正しい実績として保持します。

Trading EconomicsのForecastだけを市場予想に使います。TEForecastは同社独自予測のため代用しません。Previousは配信元で改定済みの前回値となる場合があります。[公式レスポンス定義](https://docs.tradingeconomics.com/economic_calendar/schema/)

取得できない項目はnullまたは未取得。推定時刻を正確な発表時刻に見せません。中央銀行の現行政策金利、未来のactual、未配信のコンセンサスなどを生成しません。

## 正規化とsurprise

名称はNFKC・小文字化・ハイフン等の吸収と語句パターンで、インフレ、雇用・賃金、GDP、消費、PMI／ISM／短観、金融政策を分類します。CPI、Core PCE、Non-farm Payrolls、Average Cash Earnings、Federal Funds Rate、BOJ Meetingなどの表記差を扱います。完全一致だけには依存しません。

配信元の重要度が有効なら保持し、欠けている場合に主要指標分類から補います。主要指標であることと配信元のhigh/medium/lowは別の情報です。通貨の売買方向を固定する規則はありません。

通常の10進数と、同じUnitが明示された値のみnumberへ変換します。K/M、範囲、単位不一致などは文字列のままです。surpriseはactualとforecastが有限numberで、共通unitがある場合だけ計算します。%同士の差はptで表示し、above／below／equalも渡します。たとえば3.1%と2.8%は+0.3ptです。小さな浮動小数点誤差を吸収しますが、未知の単位・文字列を無理に比較しません。

## Risk WindowとAI連携

`riskWindowPolicy`に設定を分離しました。

- high：30分前〜15分後、両端を含め待機。
- medium：15分前〜5分後、両端を含め待機。
- low：原則ブロックしない。

actualが取得できても発表後の期間は維持します。highの時刻が確認できない場合も、既存の保守的な待機方針を維持します。この状態を時刻確定済みのリスク時間帯とは区別します。

Task005のbuildInputへeventRisk、各指標のminutesUntil・inRiskWindow・riskWindow・surpriseを追加しました。リスク判定は対象通貨の全イベントを確認し、モデルへ送る指標の詳細は最大20件、理由も最大20件に制限します。全件イベント配列を重複してプロンプトへ送らないため、従来の入力サイズ制限を保ちます。

AIAnalysisへdirectionSignal、action（BUY/SELL/WAIT）、economicRiskを追加。既存signalは「今行動するか」の互換値として維持します。たとえば方向strong_sellでもリスク時間帯ならsignal=wait／action=WAIT／scenario=nullです。Task006も既存signalを読むため、待機中にポジション取得候補を出しません。スコアは方向として残ります。

AI処理中にリスク時間帯へ入った場合もサーバーで確認します。分析の有効期限を次のリスク開始までに短縮し、時間帯開始をまたぐキャッシュを防ぎます。時間帯中は終了境界も有効期限へ反映します。

## AI Prompt・Data Quality

市場予想は事実ではない、未発表actualを推測しない、未来値を予測したふりをしない、発表前後はconfidenceを下げWAITを優先する、という指示を追加しました。発表前は予想と前回値、発表後は客観的な差分を説明し、その為替への意味はテクニカル・金利・ニュースなどと合わせてAIが解釈します。

リスク時間帯／重要時刻不明では、サーバー側でもAI統合のconfidenceを15ポイント減額します。WAITの最終制御をモデルだけには任せません。

Data Qualityは既存の`categories.economic`を使います。未取得・失敗・期限切れはmissing、正常な空結果は取得できた状態として区別。経済指標の20%分の充足率に反映し、confidenceの上限へ影響します。「経済指標未取得」だけを無条件WAITの新しい規則にはしていませんが、既存の全体充足率・確信度の基準は維持します。

## キャッシュ・障害時

通常30分。確認済みのhigh/medium発表時刻が近い場合は、その時刻までTTLを短くします。発表後15分は最大1分間隔で再取得でき、実績到着後も同じ頻度上限を維持します。UIの取得は約60秒間隔なので、発表瞬間の配信を保証する機能ではありません。

単一プロセス内で共有し、3ペア間の同時取得は重複排除します。失敗は通常60秒、401/403は15分キャッシュします。ニュースの10分キャッシュ、市場データの既存キャッシュは変更していません。

HTTP 401／403／429、ネットワーク、JSON不正、権限不足を個別の状態として扱います。TEの未知国だけの制限応答や不完全な形式を空結果に変換しません。ニュース・カレンダーの並列取得とPromise.allSettledによる障害分離は維持しました。

## タイムゾーン

EODHD公式レスポンスの`date`は`YYYY-MM-DD HH:MM:SS`で、仕様ページにタイムゾーンの記載はありません。実レスポンスも401のため確認できませんでした。providerは`EODHD_CALENDAR_TIMEZONE=UTC`を明示した場合だけUTCとしてISO8601化し、UIは既存のAsia/Tokyo変換を使用します。未確認の契約で時刻を推測しない設計です。[EODHDレスポンスフィールド](https://eodhd.com/financial-apis/economic-events-data-api)

内部時刻はISO8601。Trading EconomicsのDateは公式仕様のUTCを適用し、DateSpan=0だけを確定時刻として使用します。DateSpan=1や欠落は時刻未確認とし、カウントダウン・確定時刻によるリスク窓を作りません。

Finnhubのオフセットなし時刻は、既存`FINNHUB_CALENDAR_TIMEZONE=UTC`で確認済みの場合だけUTCとして扱います。明示オフセットは変換し、不正日付・24時台などを拒否します。表示は必ずAsia/Tokyoを指定し、年を含む`2026/09/11 21:30 JST`形式です。

## UI

ダッシュボード上部に次のhighイベントを表示できる案内を追加しました。未取得の場合は「重要イベントの有無は不明」と表示します。

マーケット材料内の経済指標を、通貨・国、名称、JST時刻、重要度、残り時間、前回値、市場予想、実績、比較可能なサプライズ、待機中の注意が分かるカードにしました。近いリスク時間帯の指標を優先し、5件を超える分は展開できます。ダークテーマとスマホ対応を維持しています。

## 検証結果

- `npm run lint`：成功、警告・エラー0件。
- `npm test`：**168件成功、失敗0、スキップ0**。既存テストにEODHDの3件を追加。既存市場検証スクリプトも成功。
- `npm run build`：成功。Next.js 16.3.4の型検査・本番ビルド完了。環境由来のRosettaに関する注意表示のみ。
- `git diff --check`：成功。

追加テストはhigh境界、直後・実績到着後、medium、low、空イベント、時刻不明、UTC/オフセット/JST日跨ぎ、previous/forecast/actualの有無、差分3方向、単位不一致、名称揺れ、3通貨ペア、次回イベント、通常・直後キャッシュ、同時取得、キーなし、HTTPエラー、ネットワーク、fallback、Data Quality、WAIT強制と方向維持、AI送信上限を確認しています。

ブラウザでは390×844と1280×900で確認しました。USD/JPY・EUR/JPY・GBP/JPYを切り替え、経済指標未取得表示と「重要指標の有無は不明」を確認。横方向のはみ出しはなく、取得したブラウザコンソールにエラーはありませんでした。

また「検証専用・架空データ」と明示した一時ページで、発表前の未発表、発表後の+0.3pt、待機期間、通信失敗のカードを確認しました。これは実API確認ではありません。一時ページは削除し、最終ビルドにも含まれていません。

## 実API確認結果・既知の制限

### EODHD接続の実測

- 接続先：`https://eodhd.com/api/economic-events`。API tokenはURLクエリに必要なため、server-only providerからのみ送信し、ブラウザには公開しません。
- 取得期間：現在日から前日を含む8日間（少なくとも7日先）。キャッシュは通常30分、発表時刻が近い場合は既存`calendarTtl`で短縮します。
- HTTP結果：US、JP、GB、EUの4リクエストはいずれも401。401/403/429/5xxは`unauthorized/forbidden/rate_limited/network`へ個別変換し、応答本文やtokenをログ・UIへ出しません。
- 公式フィールド：`type`, `comparison`, `period`, `country`, `date`, `actual`, `previous`, `estimate`, `change`, `change_percentage`。`name`は`type`、`forecast`は`estimate`へ対応し、`unit`と`updatedAt`はレスポンスにないためnull／未設定です。actual／forecast／previousの実測値は401のため未確認です。
- Importance：公式レスポンス仕様にimportanceフィールドの記載がないため、存在する場合だけprovider値を採用し、通常はTask009の指標名称分類（CPI/GDP/雇用等）を使います。分類できない指標を一律highにはしません。
- 国コード：US/JP/GBは公式例にあります。Euro Areaは今回401でレスポンス値を確認できなかったため確定していません。`EODHD_EUR_COUNTRY`で実レスポンスに合わせて設定できます。
- 3通貨ペア確認：providerのペア絞り込みはUSD/JPY、EUR/JPY、GBP/JPYを共通型で扱います。実トークンでは401のため、3ペアの実イベント件数は0件ではなく「取得不能」と判定しました。
- Risk Window：EODHD実イベントを受け取れていないため、実APIイベントでのライブ検証は未実施です。既存テストでhighの30分前〜15分後、actual有無にかかわらずWAIT、direction維持を確認しています。

実Economic Calendar APIは未確認。TEキー未設定、Finnhubカレンダー無効です。ダミー実績を通常ダッシュボードへ入れていません。アプリ側の.env.local、既存キー、API契約は変更していません。

TEキーはAuthorizationヘッダーでサーバーから送信し、URL・クライアントへ含めません。.env.exampleへ空欄を追加しただけです。既存のサーバーAPIキーも維持しています。

キャッシュは単一プロセス内のみ。多インスタンスでは共有キャッシュ・共通のレート制限が必要です。リリース前後の更新で利用枠を消費するため、試用枠による常時稼働には適しません。将来は頻度を変更できるよう関数へ分離しています。

時刻変更・配信遅延・不完全な配信を完全には検知できません。「取得範囲内にない」は市場全体にイベントがない保証ではありません。時間帯終了直後も、再分析完了までは従来のWAITが残る場合があります。

## Task010への引継ぎ

1. 利用権限・商用表示条件を確認したうえで、TEキーまたはFinnhubカレンダーを設定し、4地域の実際の配信・日時・単位・権限不足時の表示を検証してください。TEを使う場合は.env.localに`TRADING_ECONOMICS_API_KEY`を設定してサーバーを再起動します。
2. 多インスタンス対応のキャッシュ・API回数制御、発表近辺の更新頻度を運用予算に合わせて調整してください。
3. 現在のEconomicEvent・取得日時・AI evidenceを基に、historical event snapshotを別途保存する設計へ拡張できます。今回はSupabase保存を追加していません。
4. Task007/008の保存済み取引スナップショットは既存形式を維持しました。directionSignal/action/経済指標リスクまで履歴に残す場合は、スナップショットのバージョン拡張を検討してください。
5. 1,000件に達する範囲や大規模履歴には期間分割・ページングを追加してください。今回は不完全な結果を表示しない方針です。

未来値のAI予測、自動注文、指標発表瞬間の売買、証券会社連携は実装していません。

---

# FRED Provider（米国マクロ実績）追記

実装日：2026-09-11。EODHD Economic Calendarは維持し、FREDは「発表済みの米国マクロ実績」として独立取得する。カレンダーが401/未設定でもFREDは動作する。コミット・pushは行っていない。

## 変更ファイル（FRED追記分）

- `lib/fundamental/fred-series.ts`：公式metadata確認済みのseries定義。
- `lib/fundamental/providers/fred.ts`：FRED observations取得、欠損処理、latest/previous、部分失敗。
- `lib/fundamental/types.ts`：`EconomicIndicatorValue` と `FundamentalData.macroeconomic`。
- `lib/fundamental/service.ts` / `client.ts` / `cache.ts`：並列取得と60分キャッシュ。
- `lib/ai/input.ts` / `types.ts` / `openai.ts`：evidence・Data Quality・Prompt統合。
- `components/dashboard/us-macro.tsx` / `fundamental.tsx` / `ai-analysis.tsx`：米国マクロUIと品質バッジ。
- `app/globals.css`：既存デザインに合わせた軽い強調。
- `.env.example`：`FRED_API_KEY=` コメント付き。
- `tests/fred.test.ts`：Provider／正規化／統合テスト。
- `tests/ai.test.ts`：fixtureにmacroeconomicを追加。
- `outputs/Task009-実装報告.md`：本追記。

## 採用series id一覧（2026-09-11 FRED series metadata APIで確認）

| 表示名 | series id | series title | native units | frequency | seasonal adjustment | observations変換 |
|---|---|---|---|---|---|---|
| 米CPI（前年比） | CPIAUCSL | Consumer Price Index for All Urban Consumers: All Items in U.S. City Average | Index 1982-1984=100 | Monthly | Seasonally Adjusted | `units=pc1`（Percent Change from Year Ago） |
| 米Core CPI（前年比） | CPILFESL | Consumer Price Index for All Urban Consumers: All Items Less Food and Energy in U.S. City Average | Index 1982-1984=100 | Monthly | Seasonally Adjusted | `units=pc1` |
| 米PCE（前年比） | PCEPI | Personal Consumption Expenditures: Chain-type Price Index | Index 2017=100 | Monthly | Seasonally Adjusted | `units=pc1` |
| 米Core PCE（前年比） | PCEPILFE | Personal Consumption Expenditures Excluding Food and Energy (Chain-Type Price Index) | Index 2017=100 | Monthly | Seasonally Adjusted | `units=pc1` |
| 米非農業部門雇用者数増減（NFP） | PAYEMS | All Employees, Total Nonfarm | Thousands of Persons | Monthly | Seasonally Adjusted | `units=chg`（前月差、千人） |
| 米失業率 | UNRATE | Unemployment Rate | Percent | Monthly | Seasonally Adjusted | `lin`（水準） |
| 米実質GDP成長率（前期比年率） | A191RL1Q225SBEA | Real Gross Domestic Product | Percent Change from Preceding Period | Quarterly | Seasonally Adjusted Annual Rate | `lin` |
| 米実効FF金利 | FEDFUNDS | Federal Funds Effective Rate | Percent | Monthly | Not Seasonally Adjusted | `lin` |

参照：[FRED series observations API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)

## 指標定義（混同防止）

- CPI / Core CPI / PCE / Core PCE：指数そのものではなく、FRED公式の`pc1`変換による前年比%を表示する。UI名に「前年比」を明示。
- NFP：PAYEMSの総雇用者数（例: 159075千人）ではなく、`chg`による前月差（例: +162 千人）を使用。自前差分計算ではなくFRED変換を利用。
- Unemployment：UNRATEの%水準。
- GDP：水準のGDPC1ではなく、A191RL1Q225SBEAの前期比年率%成長。
- Fed Funds：Effective Federal Funds Rate（FEDFUNDS）。Target Range / Upper / Lower Boundではない。表示名は「米実効FF金利」。

## latest / previous と欠損値

- observationsを`sort_order=desc&limit=8`で取得し、有効数値のみから最新と1つ前を採用。
- `"."`・空文字・非有限値はnull。NaNは渡さない。
- 有効観測が0件のseriesは失敗扱い。他seriesは継続（PARTIAL）。

## キャッシュ

- 通常60分（`cachePolicy.macroMs`）。既存`ResourceCache`を再利用し、同一プロセス内で8系列バッチを共有。
- 失敗は既存どおり60秒、401/403は15分。

## APIエラー処理

- キー未設定 / 400 / 401 / 403 / 429 / 5xx / timeout / invalid JSON / observationsなしを既存`ErrorCode`へ分類。
- UI文言は「米国マクロデータを取得できません」。キーはURL以外に出さず、レスポンスJSONにも含めない。
- EODHDカレンダー失敗とは独立（実測: calendar=error, macroeconomic=ok）。

## Data Quality / AI

- `dataQuality.macroeconomicData`: OK / PARTIAL / MISSING。
- 既存5カテゴリの加重スコアは変更せず、FRED欠損だけではWAIT強制しない。
- evidence id `macro:*` として経済カテゴリへ渡し、observationDate / unit / stale /「発表済み実績」注記を付与。
- PromptへFREDは市場予想でも将来値でもない旨を追加。

## 実API確認結果（秘密情報なし）

全8指標 HTTP成功。取得例（2026-09-11確認）:

- 米CPI（前年比）: latest 3.30386 / previous 3.46353 / 観測日 2026-07-01 / 2026-06-01
- 米Core CPI（前年比）: 2.46652 / 2.56579 / 2026-07-01
- 米PCE（前年比）: 3.70117 / 3.71697 / 2026-07-01
- 米Core PCE（前年比）: 3.34414 / 3.34361 / 2026-07-01
- NFP増減: +162 / +21 千人（前月差） / 2026-08-01
- 失業率: 4.1% / 4.1% / 2026-08-01
- 実質GDP成長率: 1.5% / 2.1% 前期比年率 / 2026-04-01 / 2026-01-01
- 米実効FF金利: 3.63% / 3.63% / 2026-08-01

単位確認: CPI系を300台の指数として%表示していない。NFPを総雇用者数扱いしていない。FFを0.0533%扱いにしていない。

## 検証

- `npm run lint`：成功（警告0）。
- `npm test`：184件成功、失敗0。
- `npm run build`：成功。
- `git diff --check`：成功。
- ブラウザ: USD/JPY・EUR/JPY・GBP/JPYで「米国マクロ」表示。EODHDカレンダー失敗時もFREDは表示継続。EUR/GBPは折りたたみ＋「USD要因として共通参照」。

## 既知の制限

- FREDはカレンダー代替ではない。市場予想・次回発表時刻は持たない。
- CPI等の最新観測が月次ラグでstale表示になる場合がある（意図的）。
- キャッシュは単一プロセス。多インスタンスでは共有が必要。
- Average Hourly Earnings / Retail Sales / Industrial Productionは今回未追加。

## 今後 BOJ / ECB / BOE を追加する場合

1. 各国中央銀行・統計局または同等の信頼できるAPIのseriesを公式metadataで確認する。
2. `EconomicIndicatorValue.country/currency`を拡張し、FRED以外のsourceを分離する。
3. UIは「米国マクロ」と並列の地域セクションにし、カレンダーとは分けたままにする。
4. AIへ渡す際も observationDate / unit / transformation を必須にし、指数と変化率を混同しない。

