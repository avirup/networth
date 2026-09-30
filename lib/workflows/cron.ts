import "server-only";
import { timingSafeEqual } from "node:crypto";
export function validCronAuthorization(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
