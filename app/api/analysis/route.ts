import { getAnalysis } from "@/lib/ai/client";
import { symbols, type Symbol } from "@/lib/market/types";
import type { AnalysisResponse } from "@/lib/ai/types";

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair");
  const headers = { "Cache-Control": "no-store" };
  if (!symbols.includes(pair as Symbol)) return Response.json({ success: false, data: null, error: { code: "invalid_pair", message: "対応していない通貨ペアです。" }, cached: false } satisfies AnalysisResponse, { status: 400, headers });
  try { return Response.json(await getAnalysis(pair as Symbol), { headers }); }
  catch { return Response.json({ success: false, data: null, error: { code: "unavailable", message: "現在分析を取得できません。" }, cached: false } satisfies AnalysisResponse, { status: 503, headers }); }
}
