import type { SVGProps } from "react";
const paths: Record<string, string> = {
  overview: "M4 11 12 4l8 7v9H4Z M9 20v-6h6v6",
  accounts: "M4 5h16v14H4Z M4 10h16 M15 15h2",
  investments: "M4 19V5 M4 19h16 M7 15l4-5 4 2 5-7",
  liabilities: "M4 7h16v13H4Z M7 7V4h10v3 M8 12h8 M8 16h4",
  activity: "M5 4h14v17H5Z M8 8h8 M8 12h8 M8 16h5",
  imports: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  settings: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M6 6l2 2 M16 16l2 2 M6 18l2-2 M16 8l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  chevron: "m9 5 7 7-7 7", down: "m6 9 6 6 6-6", close: "m6 6 12 12 M6 18 18 6",
  menu: "M4 6h16 M4 12h16 M4 18h16", plus: "M12 5v14 M5 12h14",
  calendar: "M4 6h16v15H4Z M8 3v6 M16 3v6 M4 11h16",
  bell: "M18 9a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7 M10 20h4",
  info: "M12 11v6 M12 7v1 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] ?? paths.info} /></svg>;
}
