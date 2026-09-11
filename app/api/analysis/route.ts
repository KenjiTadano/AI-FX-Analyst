import { getAnalysis } from "@/lib/ai/client";
import { sanitizeClientChartAnalysis } from "@/lib/chart-analysis/sanitize";
import { symbols, type Symbol } from "@/lib/market/types";
import type { AnalysisResponse } from "@/lib/ai/types";

const headers = { "Cache-Control": "no-store" };

function invalidPair(): Response {
  return Response.json({ success: false, data: null, error: { code: "invalid_pair", message: "対応していない通貨ペアです。" }, cached: false } satisfies AnalysisResponse, { status: 400, headers });
}

function unavailable(): Response {
  return Response.json({ success: false, data: null, error: { code: "unavailable", message: "現在分析を取得できません。" }, cached: false } satisfies AnalysisResponse, { status: 503, headers });
}

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair");
  if (!symbols.includes(pair as Symbol)) return invalidPair();
  try { return Response.json(await getAnalysis(pair as Symbol), { headers }); }
  catch { return unavailable(); }
}

/** Optional ChartImageAnalysis body. Image bytes are never accepted here. */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch {
    return Response.json({ success: false, data: null, error: { code: "invalid_body", message: "リクエスト形式が不正です。" }, cached: false } satisfies AnalysisResponse, { status: 400, headers });
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const pair = typeof record?.pair === "string" ? record.pair : null;
  if (!symbols.includes(pair as Symbol)) return invalidPair();
  const chart = record && "chartImageAnalysis" in record
    ? sanitizeClientChartAnalysis(record.chartImageAnalysis, pair as Symbol)
    : null;
  try { return Response.json(await getAnalysis(pair as Symbol, chart), { headers }); }
  catch { return unavailable(); }
}
