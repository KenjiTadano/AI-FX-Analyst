export const signalLabels = { strong_buy: "すごく買い", buy: "買い", wait: "待った", sell: "売り", strong_sell: "すごく売り", unrecorded: "未記録・通貨不一致" };
export const money = (value: number | null, signed = false) => value === null ? "—" : `${signed && value > 0 ? "+" : ""}${value.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
export const tone = (value: number) => value > 0 ? "positive" : value < 0 ? "negative" : "muted";
export const dateTime = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
export const localDateTime = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16);
export function fromLocalDateTime(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return "";
  const date = new Date(`${value}:00+09:00`);
  return Number.isFinite(date.getTime()) && localDateTime(date.toISOString()) === value ? date.toISOString() : "";
}
