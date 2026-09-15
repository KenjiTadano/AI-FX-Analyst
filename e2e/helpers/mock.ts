import type { Page, Request } from "@playwright/test";
import type { AIAnalysis } from "../../lib/ai/types";
import type { Symbol } from "../../lib/market/types";
import { e2eOrigin } from "../env";
import { analysisFixture, type AnalysisFixtureName } from "../fixtures/analysis";
import { e2eAuthCookie, e2eAuthCookieName, e2eAuthCookieValue, e2eSession, e2eUser } from "../fixtures/auth";
import { fundamentalFixture } from "../fixtures/fundamental";
import { E2E_USER_ID } from "../fixtures/ids";
import { marketFixture } from "../fixtures/market";
import { performanceTrades, settingsRow, tradeRows } from "../fixtures/trades";

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

export async function installDashboardMocks(page: Page, scenario: DashboardScenario = {}): Promise<{ leaks: string[] }> {
  const now = Date.now();
  const trades = scenario.includeTrades === false ? [] : performanceTrades(now);
  const rows = tradeRows(trades);
  const leaks: string[] = [];
  const session = e2eSession();
  const origin = e2eOrigin();
  const context = page.context();

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
    const data = resolveAnalysis(pair, scenario, now);
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(marketFixture(symbol, now)) });
  });

  await context.route(/\/api\/fundamental(?:\?|$)/, async route => {
    const symbol = (new URL(route.request().url()).searchParams.get("symbol") ?? "USD/JPY") as Symbol;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fundamentalFixture(symbol, now)) });
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
      await route.fulfill({
        status: 200,
        headers: {
          ...cors(request),
          "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
        },
        body: JSON.stringify(rows),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: cors(request), body: "[]" });
  });

  await context.route("**/*.supabase.co/**/realtime/**", async route => {
    await route.abort("blockedbyclient");
  });

  return { leaks };
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
