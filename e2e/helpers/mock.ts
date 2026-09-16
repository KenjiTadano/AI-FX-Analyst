import type { Page, Request } from "@playwright/test";
import type { AIAnalysis } from "../../lib/ai/types";
import type { Symbol } from "../../lib/market/types";
import { e2eOrigin } from "../env";
import { analysisFixture, type AnalysisFixtureName } from "../fixtures/analysis";
import { e2eAuthCookie, e2eAuthCookieName, e2eAuthCookieValue, e2eSession, e2eUser } from "../fixtures/auth";
import { fundamentalFixture, type CalendarFixtureName } from "../fixtures/fundamental";
import { E2E_USER_ID } from "../fixtures/ids";
import { marketFixture, type MtfFixtureName } from "../fixtures/market";
import { performanceTrades, preTradeFullContextTrades, preTradePerformanceTrades, postTradeReviewTrades, mtfPerformanceTrades, settingsRow, tradeRows } from "../fixtures/trades";

const BLOCKED = [
  /openai\.com/i,
  /api\.openai\.com/i,
  /twelvedata\.com/i,
  /finnhub\.io/i,
  /stlouisfed\.org/i,
  /eodhd\.com/i,
  /tradingeconomics\.com/i,
];

export type DashboardScenario = {
  analysis?: AnalysisFixtureName | "unavailable";
  analyses?: Partial<Record<Symbol, AnalysisFixtureName | "unavailable">>;
  dailyLossLimitPercent?: number | null;
  includeTrades?: boolean;
  tradeSet?: "default" | "pretrade-performance" | "pretrade-full" | "posttrade-review" | "mtf-performance";
  calendar?: CalendarFixtureName;
  marketPrice?: number;
  candleClose?: number;
  marketStale?: boolean;
  omitCandles?: boolean;
  mtf?: MtfFixtureName;
  mtfByPair?: Partial<Record<Symbol, MtfFixtureName>>;
};

function cors(request: Request): Record<string, string> {
  return {
    "access-control-allow-origin": request.headers()["origin"] ?? e2eOrigin(),
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-expose-headers": "content-range, content-profile, content-type",
    "content-type": "application/json",
  };
}

function pairFromAnalysisRequest(request: Request): string | null {
  const url = new URL(request.url());
  if (url.searchParams.get("pair")) return url.searchParams.get("pair");
  if (request.method() === "POST") {
    try {
      const body = request.postDataJSON() as { pair?: string } | null;
      return body?.pair ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveAnalysis(
  pair: string | null,
  scenario: DashboardScenario,
  now: number,
): AIAnalysis | null {
  const named = (pair && scenario.analyses?.[pair as Symbol]) || scenario.analysis || "sell-wait";
  if (!pair || named === "unavailable") return null;
  return analysisFixture(named, now, pair as Symbol);
}

export async function installDashboardMocks(page: Page, scenario: DashboardScenario = {}): Promise<{
  leaks: string[];
  setMarket: (opts: { price?: number; candleClose?: number; stale?: boolean; omitCandles?: boolean; mtf?: MtfFixtureName }) => void;
  setAnalysis: (name: AnalysisFixtureName | "unavailable") => void;
}> {
  const now = Date.now();
  const trades = scenario.includeTrades === false
    ? []
    : scenario.tradeSet === "mtf-performance"
      ? mtfPerformanceTrades(now)
    : scenario.tradeSet === "posttrade-review"
      ? postTradeReviewTrades(now)
    : scenario.tradeSet === "pretrade-full"
      ? preTradeFullContextTrades(now)
      : scenario.tradeSet === "pretrade-performance"
        ? preTradePerformanceTrades(now)
        : performanceTrades(now);
  const rows = tradeRows(trades);
  const leaks: string[] = [];
  const session = e2eSession();
  const origin = e2eOrigin();
  const context = page.context();
  const live: DashboardScenario = { ...scenario, analyses: { ...scenario.analyses } };

  await context.addCookies([e2eAuthCookie(origin)]);

  await page.addInitScript(({ cookieName, cookieValue, sessionJson, userId, limit }) => {
    try {
      document.cookie = `${cookieName}=${cookieValue}; Path=/; SameSite=Lax`;
    } catch { /* ignore */ }
    try {
      localStorage.setItem(cookieName, sessionJson);
      if (typeof limit === "number") {
        localStorage.setItem(`ai-fx-analyst.daily-loss-limit-percent:${userId}`, String(limit));
        localStorage.setItem("ai-fx-analyst.daily-loss-limit-percent:anon", String(limit));
      } else {
        localStorage.removeItem(`ai-fx-analyst.daily-loss-limit-percent:${userId}`);
        localStorage.removeItem("ai-fx-analyst.daily-loss-limit-percent:anon");
      }
    } catch { /* private mode */ }
  }, {
    cookieName: e2eAuthCookieName(),
    cookieValue: e2eAuthCookieValue(),
    sessionJson: JSON.stringify(session),
    userId: E2E_USER_ID,
    limit: scenario.dailyLossLimitPercent ?? null,
  });

  page.on("request", request => {
    const url = request.url();
    if (BLOCKED.some(pattern => pattern.test(url))) leaks.push(url.split("?")[0] ?? url);
  });

  await context.route("**/_next/hmr**", route => route.continue());

  for (const host of ["openai.com", "twelvedata.com", "finnhub.io", "stlouisfed.org", "eodhd.com", "tradingeconomics.com"]) {
    await context.route(`**/*${host}/**`, async route => {
      leaks.push(route.request().url().split("?")[0] ?? route.request().url());
      await route.abort("blockedbyclient");
    });
  }

  await context.route(/\/api\/analysis(?:\?|$)/, async route => {
    const pair = pairFromAnalysisRequest(route.request());
    const data = resolveAnalysis(pair, live, now);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data
        ? { success: true, data, error: null, cached: false }
        : { success: false, data: null, error: { code: "unavailable", message: "現在AI総合分析を取得できません。" }, cached: false }),
    });
  });

  await context.route(/\/api\/market(?:\?|$)/, async route => {
    const symbol = (new URL(route.request().url()).searchParams.get("symbol") ?? "USD/JPY") as Symbol;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(marketFixture(symbol, now, {
        price: live.marketPrice,
        candleClose: live.candleClose,
        stale: live.marketStale,
        omitCandles: live.omitCandles,
        mtf: live.mtfByPair?.[symbol] ?? live.mtf,
      })),
    });
  });

  await context.route(/\/api\/fundamental(?:\?|$)/, async route => {
    const symbol = (new URL(route.request().url()).searchParams.get("symbol") ?? "USD/JPY") as Symbol;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fundamentalFixture(symbol, now, live.calendar)) });
  });

  await context.route(/\/api\/chart-analysis(?:\?|$)/, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: { code: "not_configured", message: "E2E does not call Vision." } }),
    });
  });

  await context.route(/\/auth\/v1\//, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors(request) });
      return;
    }
    if (/\/auth\/v1\/user/.test(request.url())) {
      await route.fulfill({ status: 200, headers: cors(request), body: JSON.stringify(e2eUser()) });
      return;
    }
    await route.fulfill({ status: 200, headers: cors(request), body: JSON.stringify(session) });
  });

  await context.route(/\/rest\/v1\//, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors(request) });
      return;
    }
    const url = request.url();
    if (/\/rest\/v1\/user_settings/.test(url)) {
      await route.fulfill({ status: 200, headers: cors(request), body: JSON.stringify(settingsRow(now)) });
      return;
    }
    if (/\/rest\/v1\/trades/.test(url)) {
      const method = request.method();
      const headers = {
        ...cors(request),
        "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
      };
      if (method === "POST") {
        const parsed = request.postDataJSON() as Record<string, unknown> | Record<string, unknown>[] | null;
        const body = Array.isArray(parsed) ? parsed[0] : parsed;
        const row = { ...(body ?? {}), version: 1 };
        rows.push(row as typeof rows[number]);
        await route.fulfill({ status: 201, headers: cors(request), body: JSON.stringify(row) });
        return;
      }
      if (method === "PATCH") {
        const id = new URL(request.url()).searchParams.get("id")?.replace(/^eq\./, "") ?? "";
        const body = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
        const index = rows.findIndex(row => row.id === id);
        if (index < 0) {
          await route.fulfill({ status: 404, headers: cors(request), body: "[]" });
          return;
        }
        const previous = rows[index];
        const next = {
          ...previous,
          ...body,
          analysis_snapshot: previous.analysis_snapshot,
          version: (previous.version ?? 1) + 1,
        };
        rows[index] = next;
        await route.fulfill({ status: 200, headers: cors(request), body: JSON.stringify(next) });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify(rows),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: cors(request), body: "[]" });
  });

  await context.route("**/*.supabase.co/**/realtime/**", async route => {
    await route.abort("blockedbyclient");
  });

  return {
    leaks,
    setMarket(opts) {
      if (opts.price !== undefined) live.marketPrice = opts.price;
      if (opts.candleClose !== undefined) live.candleClose = opts.candleClose;
      if (opts.stale !== undefined) live.marketStale = opts.stale;
      if (opts.omitCandles !== undefined) live.omitCandles = opts.omitCandles;
      if (opts.mtf !== undefined) live.mtf = opts.mtf;
    },
    setAnalysis(name) {
      live.analysis = name;
    },
  };
}

export async function assertNoOverflow(page: Page) {
  const box = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (box.scrollWidth > box.clientWidth) {
    throw new Error(`horizontal overflow ${box.scrollWidth} > ${box.clientWidth}`);
  }
}

export function pairSelect(page: Page) {
  return page.locator("#currency-pair");
}

export async function advanceExistingRefresh(page: Page) {
  await page.clock.fastForward(61_000);
}
