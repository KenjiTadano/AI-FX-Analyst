import { analyzeChartImage } from "@/lib/chart-analysis/client";
import { chartAnalysisMessages, type ChartAnalysisResponse } from "@/lib/chart-analysis/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const form = await request.formData();
    const pair = form.get("pair");
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ ok: false, analysis: null, error: { code: "invalid_file", message: chartAnalysisMessages.invalid_file } } satisfies ChartAnalysisResponse, { status: 400, headers });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await analyzeChartImage({ pair, bytes, mimeHint: file.type || null, filename: file.name || null });
    const status = result.ok ? 200 : result.error.code === "not_configured" ? 503
      : result.error.code === "rate_limited" ? 429
      : result.error.code === "openai_timeout" || result.error.code === "openai_unavailable" ? 503
      : result.error.code === "invalid_ai_response" || result.error.code === "analysis_failed" ? 502
      : 400;
    return Response.json(result, { status, headers });
  } catch {
    return Response.json({ ok: false, analysis: null, error: { code: "analysis_failed", message: chartAnalysisMessages.analysis_failed } } satisfies ChartAnalysisResponse, { status: 500, headers });
  }
}
