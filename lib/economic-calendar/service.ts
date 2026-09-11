import type { EconomicCalendarProvider } from "./provider";
import { unavailable } from "../fundamental/resource";
import type { EconomicEvent } from "../fundamental/types";
export function calendarWithFallback(primary: EconomicCalendarProvider, fallback: EconomicCalendarProvider): EconomicCalendarProvider {
  return { async calendar() {
    const read = async (provider: EconomicCalendarProvider) => { try { return await provider.calendar(); } catch { return unavailable<EconomicEvent[]>("Economic Calendar", "network"); } };
    const first = await read(primary);
    if (["ok", "empty"].includes(first.status) && first.data !== null) return first;
    const second = await read(fallback);
    if (["ok", "empty"].includes(second.status) && second.data !== null) return { ...second, warnings: [...second.warnings, "Trading Economicsは未取得のためFinnhubを使用しています。"] };
    if (first.error?.code === "not_configured") return second.error?.code === "disabled" ? first : second;
    return first;
  } };
}
