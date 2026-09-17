"use client";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { monthLabel } from "@/lib/presentation/format";
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function MonthPicker({ period, current, onChange }: { period: string; current: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(period.slice(0, 4)));
  const select = (value: string) => { onChange(value); setOpen(false); };
  return <div className="period-picker">
    <button className="period-button" aria-label={`Select reporting month, ${monthLabel(period)}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setYear(Number(period.slice(0, 4))); setOpen(true); }}><Icon name="calendar" /><span>{monthLabel(period)}</span><Icon name="down" /></button>
    <Dialog open={open} onClose={() => setOpen(false)} label="Select reporting month" className="month-picker popover">
      <div className="month-picker-year"><button className="icon-button previous" aria-label="Show previous year" disabled={year <= 1900} onClick={() => setYear(year - 1)}><Icon name="chevron" /></button>
        <strong aria-live="polite">{year}</strong><button className="icon-button" aria-label="Show next year" disabled={year >= Number(current.slice(0, 4))} onClick={() => setYear(year + 1)}><Icon name="chevron" /></button></div>
      <div className="month-picker-grid" role="group" aria-label="Months" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (moves[event.key] ?? 0);
        if (next !== index) { event.preventDefault(); buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus(); }
      }}>{months.map((label, index) => {
        const value = `${year}-${String(index + 1).padStart(2, "0")}`;
        return <button key={label} autoFocus={value === period} disabled={value > current} aria-pressed={value === period} onClick={() => select(value)}>{label}</button>;
      })}</div>
      <button className="button secondary period-reset" onClick={() => select(current)}>Reset to current month</button>
      <button className="text-button close-picker" onClick={() => setOpen(false)}>Close month picker</button>
    </Dialog>
  </div>;
}
