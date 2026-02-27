import { useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, ChevronUp, ChevronDown, ChevronsUpDown,
  TrendingUp, TrendingDown, CheckCircle, Package,
  DollarSign, BarChart2, Truck, MapPin
} from "lucide-react";

type OrderSortKey = "orderNumber" | "date" | "discrepancy" | "sellingPrice" | "billedPrice" | "carrier" | "lane";
type SortDir = "asc" | "desc";

export default function CustomerDetail() {
  const params = useParams<{ name: string }>();
  const [, navigate] = useLocation();
  const customerName = decodeURIComponent(params.name ?? "");

  // Read date range from URL query params
  const searchParams = new URLSearchParams(window.location.search);
  const [dateFrom] = useState(searchParams.get("from") ?? "");
  const [dateTo] = useState(searchParams.get("to") ?? "");

  const [sortKey, setSortKey] = useState<OrderSortKey>("discrepancy");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");
  const [flagFilter, setFlagFilter] = useState<"all" | "overcharge" | "undercharge" | "match">("all");

  const ordersQ = trpc.discrepancy.getOrdersByCustomer.useQuery(
    { customer: customerName, from: dateFrom || undefined, to: dateTo || undefined },
    { enabled: !!customerName }
  );

  const orders = ordersQ.data ?? [];

  // Summary stats
  const summary = useMemo(() => {
    const totalDisc = orders.reduce((s, o) => s + o.discrepancy, 0);
    const overcharges = orders.filter(o => o.flag === "overcharge");
    const undercharges = orders.filter(o => o.flag === "undercharge");
    const matches = orders.filter(o => o.flag === "match");
    const totalSelling = orders.reduce((s, o) => s + o.sellingPrice, 0);
    const totalBilled = orders.reduce((s, o) => s + o.billedPrice, 0);
    const carriers = Array.from(new Set(orders.map(o => o.carrier).filter(Boolean)));
    const lanes = Array.from(new Set(orders.map(o => o.lane).filter(Boolean)));
    return { totalDisc, overcharges, undercharges, matches, totalSelling, totalBilled, carriers, lanes };
  }, [orders]);

  const filtered = useMemo(() => {
    let rows = orders;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(o =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.carrier.toLowerCase().includes(q) ||
        o.lane.toLowerCase().includes(q)
      );
    }
    if (flagFilter !== "all") rows = rows.filter(o => o.flag === flagFilter);
    return [...rows].sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      if (sortKey === "orderNumber") { va = a.orderNumber; vb = b.orderNumber; }
      else if (sortKey === "date") { va = a.date; vb = b.date; }
      else if (sortKey === "discrepancy") { va = a.discrepancy; vb = b.discrepancy; }
      else if (sortKey === "sellingPrice") { va = a.sellingPrice; vb = b.sellingPrice; }
      else if (sortKey === "billedPrice") { va = a.billedPrice; vb = b.billedPrice; }
      else if (sortKey === "carrier") { va = a.carrier; vb = b.carrier; }
      else if (sortKey === "lane") { va = a.lane; vb = b.lane; }
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
      return sortDir === "asc" ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  }, [orders, search, flagFilter, sortKey, sortDir]);

  function toggleSort(key: OrderSortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ k }: { k: OrderSortKey }) {
    if (sortKey !== k) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3 text-cyan-400" /> : <ChevronDown className="w-3 h-3 text-cyan-400" />;
  }

  const severity = Math.abs(summary.totalDisc) < 50 ? "green" : Math.abs(summary.totalDisc) < 500 ? "yellow" : "red";

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      {/* ── Header ── */}
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-30">
        <div className="container flex items-center gap-3 h-14">
          <button onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="w-px h-5 bg-border" />
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="font-bold text-foreground truncate max-w-xs" title={customerName}>{customerName}</span>
          <span className={`severity-${severity} ml-auto`}>
            {severity === "red" ? "⚠ Critical" : severity === "yellow" ? "◆ Moderate" : "✓ Minor"}
          </span>
          {(dateFrom || dateTo) && (
            <Badge variant="outline" className="text-xs text-cyan-400 border-cyan-400/40 hidden sm:flex">
              {dateFrom} → {dateTo}
            </Badge>
          )}
        </div>
      </header>

      <main className="container py-5 space-y-5">

        {/* ── Summary KPI Cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <KpiCard icon={<BarChart2 className="w-4 h-4" />} label="Total Orders" value={String(orders.length)} color="cyan" />
          <KpiCard icon={<DollarSign className="w-4 h-4" />} label="Net Discrepancy"
            value={`${summary.totalDisc >= 0 ? "+" : ""}$${summary.totalDisc.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            color={summary.totalDisc > 0 ? "red" : summary.totalDisc < 0 ? "yellow" : "green"} />
          <KpiCard icon={<TrendingUp className="w-4 h-4" />} label="Overcharges" value={String(summary.overcharges.length)} color="red" />
          <KpiCard icon={<TrendingDown className="w-4 h-4" />} label="Undercharges" value={String(summary.undercharges.length)} color="yellow" />
          <KpiCard icon={<CheckCircle className="w-4 h-4" />} label="Exact Match" value={String(summary.matches.length)} color="green" />
          <KpiCard icon={<Truck className="w-4 h-4" />} label="Carriers" value={String(summary.carriers.length)} color="cyan" />
        </div>

        {/* ── Totals Row ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Total Quoted (Selling)</div>
            <div className="text-xl font-bold text-foreground tabular-nums">
              ${summary.totalSelling.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs text-muted-foreground font-normal">CAD</span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Total Billed</div>
            <div className="text-xl font-bold text-foreground tabular-nums">
              ${summary.totalBilled.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs text-muted-foreground font-normal">CAD</span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide flex items-center gap-1">
              <MapPin className="w-3 h-3" /> Top Lanes
            </div>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {summary.lanes.slice(0, 4).map(l => (
                <span key={l} className="text-xs px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">{l}</span>
              ))}
              {summary.lanes.length > 4 && <span className="text-xs text-muted-foreground">+{summary.lanes.length - 4} more</span>}
            </div>
          </div>
        </div>

        {/* ── Order Table ── */}
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center gap-3">
            <h2 className="font-semibold text-foreground flex-1">Order-by-Order Breakdown</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {(["all", "overcharge", "undercharge", "match"] as const).map(f => (
                <button key={f} onClick={() => setFlagFilter(f)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    flagFilter === f
                      ? f === "overcharge" ? "bg-red-500/20 border-red-500/60 text-red-400"
                        : f === "undercharge" ? "bg-yellow-500/20 border-yellow-500/60 text-yellow-400"
                        : f === "match" ? "bg-green-500/20 border-green-500/60 text-green-400"
                        : "bg-cyan-400/20 border-cyan-400/60 text-cyan-400"
                      : "border-border text-muted-foreground hover:border-border/80"
                  }`}>
                  {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
              <Input placeholder="Search order, carrier, lane…" value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-44 h-7 text-xs bg-input border-border" />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  {([
                    { key: "orderNumber" as OrderSortKey, label: "Order #" },
                    { key: "date" as OrderSortKey, label: "Date" },
                    { key: "carrier" as OrderSortKey, label: "Carrier" },
                    { key: "lane" as OrderSortKey, label: "Lane" },
                    { key: "sellingPrice" as OrderSortKey, label: "Quoted (CAD)" },
                    { key: "billedPrice" as OrderSortKey, label: "Billed (CAD)" },
                    { key: "discrepancy" as OrderSortKey, label: "Discrepancy" },
                  ]).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)}
                      className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap">
                      <span className="flex items-center gap-1">{col.label} <SortIcon k={col.key} /></span>
                    </th>
                  ))}
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Flag</th>
                </tr>
              </thead>
              <tbody>
                {ordersQ.isLoading ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array.from({ length: 8 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 bg-muted/40 rounded animate-pulse" style={{ width: j === 0 ? "70%" : "55%" }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-sm">No orders found</td></tr>
                ) : (
                  filtered.map((o, i) => (
                    <tr key={o.orderNumber} className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "" : "bg-muted/5"}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-cyan-400">{o.orderNumber}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{o.date}</td>
                      <td className="px-4 py-2.5 text-foreground text-xs">{o.carrier || "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{o.lane || "—"}</td>
                      <td className="px-4 py-2.5 tabular-nums text-xs text-foreground">
                        ${o.sellingPrice.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-xs text-foreground">
                        ${o.billedPrice.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className={`px-4 py-2.5 tabular-nums text-xs font-semibold ${
                        o.discrepancy > 0 ? "text-red-400" : o.discrepancy < 0 ? "text-yellow-400" : "text-green-400"
                      }`}>
                        {o.discrepancy >= 0 ? "+" : ""}${o.discrepancy.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={
                          o.flag === "overcharge" ? "severity-red" :
                          o.flag === "undercharge" ? "severity-yellow" : "severity-green"
                        }>
                          {o.flag === "overcharge" ? "⚠ Over" : o.flag === "undercharge" ? "◆ Under" : "✓ Match"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
            Showing {filtered.length} of {orders.length} orders
          </div>
        </div>
      </main>
    </div>
  );
}

function KpiCard({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string;
  color: "cyan" | "red" | "yellow" | "green";
}) {
  const colors = {
    cyan: "border-cyan-400/30 text-cyan-400",
    red: "border-red-400/30 text-red-400",
    yellow: "border-yellow-400/30 text-yellow-400",
    green: "border-green-400/30 text-green-400",
  };
  return (
    <div className={`rounded-lg border bg-card p-3 ${colors[color]}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="opacity-80">{icon}</span>
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-lg font-bold text-foreground tabular-nums leading-tight">{value}</div>
    </div>
  );
}
