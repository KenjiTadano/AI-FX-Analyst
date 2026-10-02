import type { EconomicCalendarProvider } from "./provider";
import { unavailable } from "../fundamental/resource";
import type { EconomicEvent } from "../fundamental/types";
export function calendarWithFallback(primary: EconomicCalendarProvider, fallback: EconomicCalendarProvider): EconomicCalendarProvider {
  return { async calendar() {
    const read = async (provider: EconomicCalendarProvider) => { try { return await provider.calendar(); } catch { return unavailable<EconomicEvent[]>("Economic Calendar", "network"); } };
    const first = await read(primary);
    if (!first.stale && ["ok", "empty"].includes(first.status) && first.data !== null) return first;
    const second = await read(fallback);
    if (!second.stale && ["ok", "empty"].includes(second.status) && second.data !== null) {
      return { ...second, warnings: [...second.warnings, "上位の経済カレンダー取得元が利用できなかったため、代替取得元を使用しています。"] };
    }
    if (first.stale && first.data !== null) return first;
    if (second.stale && second.data !== null) return { ...second, warnings: [...second.warnings, "上位の経済カレンダー取得元が利用できなかったため、代替取得元の最終成功データを表示しています。"] };
    if (first.error?.code === "not_configured") return second.error?.code === "disabled" ? first : second;
    return first;
  } };
}
