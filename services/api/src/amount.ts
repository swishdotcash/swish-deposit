/** Token amounts: decimal strings at the edge ("1.5"), base units inside (1500000n). */

export function toBaseUnits(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error("amount must be a decimal string, e.g. \"12.50\"");
  const [, whole, fraction = ""] = m;
  if (fraction.length > decimals) throw new Error(`amount has more than ${decimals} decimals`);
  return BigInt(whole! + fraction.padEnd(decimals, "0"));
}

export function fromBaseUnits(units: bigint | string, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
