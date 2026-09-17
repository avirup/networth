// Working name, centralized until the final product name is chosen.
export const PRODUCT_NAME = "networth";
export const navigation = [
  { id: "overview", label: "Overview", available: true },
  { id: "accounts", label: "Accounts", available: false },
  { id: "investments", label: "Investments", available: false },
  { id: "liabilities", label: "Liabilities", available: false },
  { id: "activity", label: "Activity", available: false },
  { id: "imports", label: "Imports", available: false },
  { id: "settings", label: "Settings", available: false },
] as const;
export type Section = typeof navigation[number]["id"];
