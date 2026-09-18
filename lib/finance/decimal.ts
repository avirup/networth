import Decimal from "decimal.js";
// Enough precision for products/sums of NUMERIC(38,18), independent of global config.
export const D = Decimal.clone({ precision: 90, rounding: Decimal.ROUND_HALF_UP });
export function decimal(value: string, scale = 12, precision = 38) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("Expected a plain decimal string.");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (whole!.length > precision - scale || fraction.length > scale) throw new Error("Decimal exceeds the permitted precision or scale.");
  return new D(value);
}
export function money(value: string) { return decimal(value).toFixed(12); }
export function settle(value: string, digits = 2) { return decimal(value).toDecimalPlaces(digits, D.ROUND_HALF_UP).toFixed(digits); }
export function economicDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31" || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Invalid economic date.");
  return value;
}
export function calendarDate(value: string) {
  economicDate(value);
  const year = parseInt(value.slice(0,4),10), month = parseInt(value.slice(5,7),10);
  return { day:value, year, month, financialYear:month<4?year-1:year, financialQuarter:Math.floor(((month+8)%12)/3)+1 };
}
