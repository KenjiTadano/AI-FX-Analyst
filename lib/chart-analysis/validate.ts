import { symbols, type Symbol } from "../market/types";
import { ALLOWED_CHART_MIME, MAX_CHART_IMAGE_BYTES, type AllowedChartMime, type ChartAnalysisErrorCode } from "./types";

const signatures: Record<AllowedChartMime, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP checked separately
};

function matches(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectImageMime(bytes: Uint8Array): AllowedChartMime | null {
  if (bytes.length < 12) return null;
  if (matches(bytes, signatures["image/png"][0]!)) return "image/png";
  if (matches(bytes, signatures["image/jpeg"][0]!)) return "image/jpeg";
  if (matches(bytes, signatures["image/webp"][0]!) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export function normalizePair(value: unknown): Symbol | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase().replace(/\s+/g, "");
  const withSlash = trimmed.includes("/") ? trimmed : trimmed.length === 6 ? `${trimmed.slice(0, 3)}/${trimmed.slice(3)}` : trimmed;
  return symbols.includes(withSlash as Symbol) ? withSlash as Symbol : null;
}

export function validateChartUpload(input: { pair: unknown; bytes: Uint8Array; mimeHint?: string | null; filename?: string | null }):
  | { ok: true; pair: Symbol; mime: AllowedChartMime }
  | { ok: false; code: ChartAnalysisErrorCode } {
  const pair = normalizePair(input.pair);
  if (!pair) return { ok: false, code: "invalid_pair" };
  if (!input.bytes.length) return { ok: false, code: "invalid_file" };
  if (input.bytes.byteLength > MAX_CHART_IMAGE_BYTES) return { ok: false, code: "file_too_large" };
  const detected = detectImageMime(input.bytes);
  if (!detected) return { ok: false, code: "unsupported_file" };
  const hint = input.mimeHint?.toLowerCase() ?? "";
  if (hint && hint !== "application/octet-stream" && !ALLOWED_CHART_MIME.includes(hint as AllowedChartMime)) return { ok: false, code: "unsupported_file" };
  if (hint && ALLOWED_CHART_MIME.includes(hint as AllowedChartMime) && hint !== detected) return { ok: false, code: "unsupported_file" };
  const name = input.filename?.toLowerCase() ?? "";
  if (name && /\.(pdf|svg|exe|mp4|mov|zip|js|html?)$/.test(name)) return { ok: false, code: "unsupported_file" };
  return { ok: true, pair, mime: detected };
}
