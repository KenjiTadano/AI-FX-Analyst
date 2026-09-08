// Convert the decimal representation to an exact fraction before dividing units.
// This avoids binary floating-point rounding up a position at budget boundaries.
export function fraction(value: number): [bigint, bigint] {
  const [coefficient, exponent = "0"] = value.toString().toLowerCase().split("e");
  const decimals = coefficient.split(".")[1]?.length ?? 0;
  const scale = decimals - Number(exponent);
  const digits = BigInt(coefficient.replace(".", ""));
  return scale >= 0 ? [digits, BigInt(10) ** BigInt(scale)] : [digits * BigInt(10) ** BigInt(-scale), BigInt(1)];
}
export function distance(a: number, b: number): [bigint, bigint] {
  const [an, ad] = fraction(a), [bn, bd] = fraction(b);
  const n = an * bd - bn * ad;
  return [n < BigInt(0) ? -n : n, ad * bd];
}
export function ceilYenCents(n: bigint, d: bigint): number { return Number((n * BigInt(100) + d - BigInt(1)) / d) / 100; }
