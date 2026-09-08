import { getMarketData } from "@/lib/market/client";
import { symbols, type Symbol } from "@/lib/market/types";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol");
  if (!symbols.includes(symbol as Symbol)) return Response.json({ error: "対応していない通貨ペアです。" }, { status: 400 });
  return Response.json(await getMarketData(symbol as Symbol), { headers: { "Cache-Control": "no-store" } });
}
