// Fingerprints are suggestions, never proof that two bank movements are the same.
export function duplicateAssessment(input: { idempotencyKey: string; contentHash: string; accountId: string }, existing: { idempotencyKey: string; contentHash: string; accountId: string }[]) {
  const retry = existing.find(item => item.idempotencyKey === input.idempotencyKey);
  if (retry) return retry.contentHash === input.contentHash && retry.accountId === input.accountId ? "exact_retry" : "idempotency_conflict";
  return existing.some(item => item.accountId === input.accountId && item.contentHash === input.contentHash) ? "review_possible_duplicate" : "new";
}
