export const CATEGORY_DEFINITIONS = [
  ["grocery", "Grocery", "expense"], ["dining", "Dining", "expense"],
  ["entertainment", "Entertainment", "expense"], ["transport", "Transport", "expense"],
  ["utilities", "Utilities", "expense"], ["healthcare", "Healthcare", "expense"],
  ["housing", "Housing", "expense"], ["education", "Education", "expense"],
  ["fees", "Fees & charges", "expense"], ["other_expense", "Other expense", "expense"],
  ["salary", "Salary", "income"], ["interest", "Interest", "income"],
  ["dividends", "Dividends", "income"], ["rental_income", "Rental income", "income"],
  ["other_income", "Other income", "income"],
] as const;
export type CategoryKind = "income" | "expense";
export function categoryFor(code: string, kind: CategoryKind) {
  if (!code) return null; // Explicitly uncategorized; never guess from narration.
  const category = CATEGORY_DEFINITIONS.find(item => item[0] === code && item[2] === kind);
  if (!category) throw new Error(`Unknown ${kind} category code.`);
  return category[0];
}
