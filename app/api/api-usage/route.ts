import { getApiUsageSnapshot } from "@/lib/api-usage";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404, headers });
  return Response.json(getApiUsageSnapshot(), { headers });
}