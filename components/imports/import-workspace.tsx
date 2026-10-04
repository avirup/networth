"use client";
import { useState } from "react";
import { BankImport } from "./bank-import";
import { CardImport } from "./card-import";

export function ImportWorkspace({ canImport }: { canImport: boolean }) {
  const [kind, setKind] = useState<"bank" | "card">("bank");
  return <>
    <nav className="import-switch" aria-label="Statement type">
      <button className={kind === "bank" ? "is-active" : ""} aria-pressed={kind === "bank"} onClick={() => setKind("bank")}>Bank account</button>
      <button className={kind === "card" ? "is-active" : ""} aria-pressed={kind === "card"} onClick={() => setKind("card")}>Credit card</button>
    </nav>
    {kind === "bank" ? <BankImport canImport={canImport} /> : <CardImport canImport={canImport} />}
  </>;
}
