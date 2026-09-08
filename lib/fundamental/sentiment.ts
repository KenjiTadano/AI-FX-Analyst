import { missing } from "./central-banks";
import type { Currency, DataResource, SentimentData } from "./types";

export async function getSentiment(currencies: Currency[]): Promise<DataResource<SentimentData>> {
  return {
    data: { market: missing("市場全体のリスク選好を裏付けるデータは未接続です。"), currencies: currencies.map(currency => ({ currency, sentiment: missing("通貨別センチメントの取得元は未接続です。") })) },
    status: "unavailable", provider: "unconfigured", fetchedAt: null, error: null, warnings: [],
  };
}
