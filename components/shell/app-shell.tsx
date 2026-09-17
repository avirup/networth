"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { navigation, type Section } from "@/lib/presentation/product";
import { Brand } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/dialog";
import { MonthPicker } from "./month-picker";

export type ShellIdentity = { name: string; initials: string; description: string; actions: { label: string; href: string }[] };

let fallbackCollapsed = false;
const preferenceKey = "networth.sidebar-collapsed";
function subscribe(listener: () => void) { window.addEventListener("storage", listener); return () => window.removeEventListener("storage", listener); }
function getPreference() { try { return localStorage.getItem(preferenceKey) === "true"; } catch { return fallbackCollapsed; } }

export function Sidebar({ active, collapsed, onToggle, href, onNavigate, mobile = false }: {
  active: Section; collapsed: boolean; onToggle: () => void; href: (section: Section) => string; onNavigate?: () => void; mobile?: boolean;
}) {
  return <div className="sidebar-content"><div className="nav-header"><Brand href={href("overview")} />
    <button className="icon-button nav-toggle" aria-label={mobile ? "Close navigation" : collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={mobile || !collapsed} onClick={onToggle}><Icon name={mobile ? "close" : "chevron"} /></button></div>
    <nav className="nav-list" aria-label="Workspace">{navigation.filter(item => item.id !== "settings" && item.id !== "imports").map(item =>
      <Link key={item.id} href={href(item.id)} className={`nav-link ${active === item.id ? "active" : ""}`} aria-current={active === item.id ? "page" : undefined}
        title={`${item.label}${!item.available ? " · Coming later" : ""}`} aria-label={item.label} onClick={onNavigate}><Icon name={item.id} /><span>{item.label}</span></Link>)}</nav>
    <div className="nav-bottom"><Link href={href("settings")} className={`nav-link ${active === "settings" ? "active" : ""}`} aria-current={active === "settings" ? "page" : undefined} aria-label="Settings" title="Settings" onClick={onNavigate}><Icon name="settings" /><span>Settings</span></Link>
      <Link className="button import-button" href={href("imports")} aria-current={active === "imports" ? "page" : undefined} aria-label="Import data" title="Import data" onClick={onNavigate}><Icon name="plus" /><span>Import data</span></Link></div>
  </div>;
}

export function Topbar({ title, period, current, onPeriodChange, onOpenNavigation, identity, notifications }: {
  title: string; period: string; current: string; onPeriodChange: (value: string) => void; onOpenNavigation: () => void; identity: ShellIdentity; notifications: string;
}) {
  const [overlay, setOverlay] = useState<"profile" | "notifications" | null>(null);
  return <header className="topbar"><div className="topbar-start"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-haspopup="dialog" onClick={onOpenNavigation}><Icon name="menu" /></button>
    <div className="topbar-copy"><h1 tabIndex={-1} id="page-title">{title}</h1><p>A clear view of your household’s finances.</p></div></div>
    <div className="topbar-actions"><MonthPicker period={period} current={current} onChange={onPeriodChange} />
      <button className="icon-button notification-button" aria-label="View notifications" aria-haspopup="dialog" aria-expanded={overlay === "notifications"} onClick={() => setOverlay("notifications")}><Icon name="bell" /></button>
      <button className="profile-button" aria-label={`Open ${identity.name.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={overlay === "profile"} onClick={() => setOverlay("profile")}><span className="profile-avatar">{identity.initials}</span><Icon name="down" /></button>
    </div>
    <Dialog open={overlay !== null} onClose={() => setOverlay(null)} label={overlay === "profile" ? identity.name : "Notifications"} className="utility-popover popover">
      {overlay === "profile" ? <><h2>{identity.name}</h2><p>{identity.description}</p>{identity.actions.map(action => <Link key={action.label} className="menu-link" href={action.href} onClick={() => setOverlay(null)}>{action.label}</Link>)}</>
        : <><h2>Notifications</h2><p>{notifications}</p></>}
      <button className="text-button" onClick={() => setOverlay(null)}>Close</button>
    </Dialog>
  </header>;
}

export function AppShell({ active, period, current, onPeriodChange, href, identity, notifications, children }: {
  active: Section; period: string; current: string; onPeriodChange: (value: string) => void; href: (section: Section) => string; identity: ShellIdentity; notifications: string; children: ReactNode;
}) {
  const collapsed = useSyncExternalStore(subscribe, getPreference, () => false);
  const [drawer, setDrawer] = useState(false);
  const previousSection = useRef(active);
  const toggle = () => { fallbackCollapsed = !collapsed; try { localStorage.setItem(preferenceKey, String(!collapsed)); } catch { /* Keep navigation usable when storage is disabled. */ } window.dispatchEvent(new Event("storage")); };
  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (media.matches) setDrawer(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  useEffect(() => {
    if (previousSection.current !== active) { document.getElementById("page-title")?.focus(); previousSection.current = active; }
  }, [active]);
  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar desktop-sidebar" aria-label="Primary navigation"><Sidebar active={active} collapsed={collapsed} onToggle={toggle} href={href} /></aside>
    <Dialog open={drawer} onClose={() => setDrawer(false)} label="Navigation" className="drawer-dialog"><Sidebar active={active} collapsed={false} onToggle={() => setDrawer(false)} href={href} mobile onNavigate={() => setDrawer(false)} /></Dialog>
    <div className="main"><Topbar title={active === "overview" ? "Your financial overview" : navigation.find(item => item.id === active)!.label} period={period} current={current} onPeriodChange={onPeriodChange} onOpenNavigation={() => setDrawer(true)} identity={identity} notifications={notifications} />
      <main id="main-content" tabIndex={-1} className="dashboard-content">{children}</main></div>
  </div>;
}
