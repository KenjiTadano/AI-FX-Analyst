import type { DataResource, EconomicEvent } from "../fundamental/types";
export interface EconomicCalendarProvider { calendar(): Promise<DataResource<EconomicEvent[]>> }
