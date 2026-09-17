/** Presentation only: keep decimal strings exact, including values beyond Number precision. */
export function formatMoney(value: string, fractionDigits = 0): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Expected a decimal string");
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 18) throw new Error("Invalid display precision");
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  // Deliberately truncate display precision; authoritative rounding belongs upstream.
  const tail = integer.slice(-3);
  const head = integer.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const digits = fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  return `${negative && /[1-9]/.test(integer + digits) ? "−" : ""}₹${head ? head + "," : ""}${tail}${fractionDigits ? "." + digits : ""}`;
}

export function monthLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year!, month! - 1)));
}
export function currentMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}
export function validMonth(value: string, latest: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "1900-01" && value <= latest;
}
