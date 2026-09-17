"use client";
import { useState, type CSSProperties, type ReactNode } from "react";

function SampleChart({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<string | null>(null);
  return <div className="chart-preview" onFocusCapture={event => setValue(event.target.getAttribute("aria-label"))}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setValue(null); }}
    onPointerOver={event => {
      // Scrolling a focused segment can move another segment beneath a stationary pointer.
      // Keep keyboard focus authoritative until focus leaves the chart.
      if (event.currentTarget.contains(document.activeElement) && document.activeElement?.hasAttribute("data-chart-mark")) return;
      const mark = (event.target as Element).closest("[data-chart-mark]"); setValue(mark?.getAttribute("aria-label") ?? null); }}
    onPointerLeave={event => setValue(event.currentTarget.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") ?? null : null)}>
    <div className="sample-chart">{children}</div>{value && <div className="chart-tooltip" aria-hidden="true">{value}</div>}
  </div>;
}
/** Static synthetic chart geometry extracted from the approved mockup, not a calculation engine. */
export function SampleMonthlyFlow() { return <SampleChart><svg className="dashboard-flow-svg" viewBox="0 38 720 285" role="group" aria-labelledby="dashboardSankeyTitle dashboardSankeyDesc">
                      <title id="dashboardSankeyTitle">Where this month’s money went</title>
                      <desc id="dashboardSankeyDesc">Salary, freelance, and other income total 3.85 lakh rupees. The income flows to essential and lifestyle expenses, investments, debt repayment, and free cash.</desc>

                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--hero)", "--link-width": "121"} as CSSProperties} d="M130 150 C210 150 272 150 352 151"  tabIndex={0} data-chart-mark role="img" aria-label="Salary contributed 3 lakh 10 thousand rupees" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--accent)", "--link-width": "21"} as CSSProperties} d="M130 226 C210 226 272 222 352 222"  tabIndex={0} data-chart-mark role="img" aria-label="Freelance contributed 55 thousand rupees" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--amber)", "--link-width": "8"} as CSSProperties} d="M130 250 C210 250 272 236 352 236"  tabIndex={0} data-chart-mark role="img" aria-label="Other income contributed 20 thousand rupees" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--coral)", "--link-width": "40"} as CSSProperties} d="M362 110 C445 110 519 65 602 65"  tabIndex={0} data-chart-mark role="img" aria-label="1 lakh 2 thousand rupees went to essential expenses" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--pink)", "--link-width": "16"} as CSSProperties} d="M362 138 C445 138 519 113 602 113"  tabIndex={0} data-chart-mark role="img" aria-label="40 thousand 800 rupees went to lifestyle expenses" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--accent)", "--link-width": "47"} as CSSProperties} d="M362 169 C445 169 519 178 602 178"  tabIndex={0} data-chart-mark role="img" aria-label="1 lakh 20 thousand rupees went to investments" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--amber)", "--link-width": "14"} as CSSProperties} d="M362 199 C445 199 519 237 602 237"  tabIndex={0} data-chart-mark role="img" aria-label="35 thousand rupees went to debt repayment" />
                      <path className="dashboard-flow-mark dashboard-sankey-link" style={{"--link-color": "var(--hero)", "--link-width": "34"} as CSSProperties} d="M362 223 C445 223 519 297 602 297"  tabIndex={0} data-chart-mark role="img" aria-label="87 thousand 200 rupees remained as free cash" />

                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--hero)"} as CSSProperties} d="M132 89.5 H126 Q120 89.5 120 95.5 V204.5 Q120 210.5 126 210.5 H132 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--accent)"} as CSSProperties} d="M132 215.5 H126 Q120 215.5 120 221.5 V230.5 Q120 236.5 126 236.5 H132 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--amber)"} as CSSProperties} d="M132 246 H124 Q120 246 120 250 Q120 254 124 254 H132 Z" />
                      <rect className="dashboard-sankey-node" style={{"--node-color": "var(--ink)"} as CSSProperties} x="350" y="90" width="14" height="150" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--coral)"} as CSSProperties} d="M600 45 H606 Q612 45 612 51 V79 Q612 85 606 85 H600 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--pink)"} as CSSProperties} d="M600 105 H606 Q612 105 612 111 V115 Q612 121 606 121 H600 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--accent)"} as CSSProperties} d="M600 154.5 H606 Q612 154.5 612 160.5 V195.5 Q612 201.5 606 201.5 H600 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--amber)"} as CSSProperties} d="M600 230 H606 Q612 230 612 236 V238 Q612 244 606 244 H600 Z" />
                      <path className="dashboard-sankey-node" style={{"--node-color": "var(--hero)"} as CSSProperties} d="M600 280 H606 Q612 280 612 286 V308 Q612 314 606 314 H600 Z" />

                      <text className="dashboard-sankey-label" x="104" y="144" textAnchor="end">Salary</text>
                      <text className="dashboard-sankey-value" x="104" y="160" textAnchor="end">₹3,10,000</text>
                      <text className="dashboard-sankey-label" x="104" y="221" textAnchor="end">Freelance</text>
                      <text className="dashboard-sankey-value" x="104" y="237" textAnchor="end">₹55,000</text>
                      <text className="dashboard-sankey-label" x="104" y="247" textAnchor="end">Other income</text>
                      <text className="dashboard-sankey-value" x="104" y="263" textAnchor="end">₹20,000</text>
                      <text className="dashboard-sankey-label" x="628" y="61">Essentials</text>
                      <text className="dashboard-sankey-value" x="628" y="77">₹1,02,000</text>
                      <text className="dashboard-sankey-label" x="628" y="110">Lifestyle</text>
                      <text className="dashboard-sankey-value" x="628" y="126">₹40,800</text>
                      <text className="dashboard-sankey-label" x="628" y="174">Investments</text>
                      <text className="dashboard-sankey-value" x="628" y="190">₹1,20,000</text>
                      <text className="dashboard-sankey-label" x="628" y="234">Debt repayment</text>
                      <text className="dashboard-sankey-value" x="628" y="250">₹35,000</text>
                      <text className="dashboard-sankey-label" x="628" y="294">Free cash</text>
                      <text className="dashboard-sankey-value" x="628" y="310">₹87,200</text>
                    </svg></SampleChart>; }
export function SampleNetWorthBridge() { return <SampleChart><svg className="dashboard-flow-svg" viewBox="0 0 420 300" role="group" aria-labelledby="dashboardWaterfallTitle dashboardWaterfallDesc">
                    <title id="dashboardWaterfallTitle">Present net worth calculation</title>
                    <desc id="dashboardWaterfallDesc">Cash, investments, and other assets add to net worth while liabilities reduce it, resulting in a net worth of 1 crore 24 lakh 50 thousand rupees.</desc>

                    <g className="dashboard-waterfall-grid" aria-hidden="true">
                      <line x1="42" y1="240" x2="402" y2="240" />
                      <line x1="42" y1="175" x2="402" y2="175" />
                      <line x1="42" y1="110" x2="402" y2="110" />
                      <line x1="42" y1="45" x2="402" y2="45" />
                      <text x="34" y="244">₹0</text>
                      <text x="34" y="179">₹50L</text>
                      <text x="34" y="114">₹100L</text>
                      <text x="34" y="49">₹150L</text>
                    </g>

                    <line className="dashboard-waterfall-connector" x1="99" y1="232" x2="130" y2="232" />
                    <line className="dashboard-waterfall-connector" x1="174" y1="212" x2="205" y2="212" />
                    <line className="dashboard-waterfall-connector" x1="249" y1="66" x2="280" y2="66" />
                    <line className="dashboard-waterfall-connector" x1="324" y1="78" x2="355" y2="78" />

                    <g className="dashboard-flow-mark dashboard-waterfall-step is-cash"  tabIndex={0} data-chart-mark role="img" aria-label="Cash adds 6 lakh 50 thousand rupees">
                      <rect x="55" y="232" width="44" height="8" rx="4" />
                      <text className="dashboard-waterfall-value" x="77" y="222">+₹6.5L</text>
                      <text className="dashboard-waterfall-label" x="77" y="264">Cash</text>
                    </g>
                    <g className="dashboard-flow-mark dashboard-waterfall-step is-investment"  tabIndex={0} data-chart-mark role="img" aria-label="Investments add 15 lakh 1 thousand rupees">
                      <rect x="130" y="212" width="44" height="20" rx="7" />
                      <text className="dashboard-waterfall-value" x="152" y="202">+₹15.0L</text>
                      <text className="dashboard-waterfall-label" x="152" y="264">Investments</text>
                    </g>
                    <g className="dashboard-flow-mark dashboard-waterfall-step is-other"  tabIndex={0} data-chart-mark role="img" aria-label="Property adds 1 crore 11 lakh 99 thousand rupees">
                      <rect x="205" y="66" width="44" height="146" rx="8" />
                      <text className="dashboard-waterfall-value" x="227" y="56">+₹112.0L</text>
                      <text className="dashboard-waterfall-label" x="227" y="264">Property</text>
                    </g>
                    <g className="dashboard-flow-mark dashboard-waterfall-step is-liability"  tabIndex={0} data-chart-mark role="img" aria-label="Liabilities subtract 9 lakh rupees">
                      <rect x="280" y="66" width="44" height="12" rx="6" />
                      <text className="dashboard-waterfall-value" x="302" y="56">−₹9.0L</text>
                      <text className="dashboard-waterfall-label" x="302" y="264">Liabilities</text>
                    </g>
                    <g className="dashboard-flow-mark dashboard-waterfall-step is-total"  tabIndex={0} data-chart-mark role="img" aria-label="Present net worth is 1 crore 24 lakh 50 thousand rupees">
                      <rect x="355" y="78" width="44" height="162" rx="8" />
                      <text className="dashboard-waterfall-value" x="377" y="68">₹124.5L</text>
                      <text className="dashboard-waterfall-label" x="377" y="264">Net worth</text>
                    </g>
                  </svg></SampleChart>; }
