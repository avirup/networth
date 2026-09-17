"use client";
import { useState, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { Section } from "@/lib/presentation/product";
export function Workspace({ name, role, section, current, children }: { name: string; role: string; section: Section; current: string; children: ReactNode }) {
  const [period, setPeriod] = useState(current);
  return <AppShell active={section} current={current} period={period} onPeriodChange={setPeriod} href={value => value === "overview" ? "/dashboard" : `/dashboard/${value}`} identity={{ name, initials: name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase(), description: `Household ${role}`, actions: [{ label: "Security settings", href: "/dashboard/settings" }, { label: "Sign out", href: "/logout" }] }} notifications="There are no notifications yet.">{children}</AppShell>;
}
