import type { DataResource, ErrorCode } from "./types";
export class ProviderError extends Error {
  constructor(public code: ErrorCode) { super(code); }
}
const messages: Record<ErrorCode, string> = {
  not_configured: "APIキーが未設定です。設定後にサーバーを再起動してください。",
  disabled: "経済指標の接続は無効です。有料の利用権限を確認後に有効化できます。",
  unauthorized: "APIキーが無効です。設定を確認してください。",
  forbidden: "契約プランに取得権限がありません。",
  rate_limited: "取得サービスの利用上限に達しました。時間をおいて再試行します。",
  network: "現在データを取得できません。時間をおいて再試行します。",
  invalid_response: "取得データの形式を確認できませんでした。",
  unsupported: "取得元が未接続のため未取得です。",
};
export function unavailable<T>(provider: string, code: ErrorCode): DataResource<T> {
  return { data: null, status: ["not_configured", "disabled", "unsupported"].includes(code) ? "unavailable" : "error", provider, fetchedAt: null, error: { code, message: messages[code] }, warnings: [] };
}
export function settled<T>(result: PromiseSettledResult<DataResource<T>>, provider: string): DataResource<T> {
  return result.status === "fulfilled" ? result.value : unavailable(provider, "network");
}
