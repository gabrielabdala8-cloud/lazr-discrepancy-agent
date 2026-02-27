import { useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Streamdown } from "streamdown";
import {
  AlertTriangle, TrendingUp, TrendingDown, Users,
  Send, Bot, ChevronUp, ChevronDown, ChevronsUpDown, Activity,
  DollarSign, BarChart2, CheckCircle, Calendar, Bell, ExternalLink,
  Upload, FileText, X
} from "lucide-react";

type SortKey = "customer" | "orders" | "totalDiscrepancy" | "discrepancyRate" | "severity";
type SortDir = "asc" | "desc";

// Quick date-range presets
const PRESETS = [
  { label: "Last 7d", days: 7 },
  { label: "Last 30d", days: 30 },
  { label: "Last 90d", days: 90 },
  { label: "6 months", days: 180 },
];

function toISO(d: Date) { return d.toISOString().substring(0, 10); }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); }

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey] = useState<SortKey>("totalDiscrepancy");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<"all" | "red" | "yellow" | "green">("all");
  const [dateFrom, setDateFrom] = useState<string>(daysAgo(180));
  const [dateTo, setDateTo] = useState<string>(toISO(new Date()));
  const [activePreset, setActivePreset] = useState<number>(180);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dateInput = useMemo(() => ({ from: dateFrom, to: dateTo }), [dateFrom, dateTo]);

  const statsQ = trpc.discrepancy.getStats.useQuery(dateInput);
  const customersQ = trpc.discrepancy.getCustomers.useQuery(dateInput);
  const uploadMut = trpc.discrepancy.uploadCSV.useMutation({
    onSuccess: () => {
      setUploadError(null);
      statsQ.refetch();
      customersQ.refetch();
    },
    onError: (err) => setUploadError(err.message),
  });
  const chatMut = trpc.discrepancy.chat.useMutation();

  const stats = statsQ.data;
  const customers = customersQ.data ?? [];
  const hasData = stats?.hasData ?? false;

  function applyPreset(days: number) {
    setActivePreset(days);
    setDateFrom(daysAgo(days));
    setDateTo(toISO(new Date()));
  }

  async function handleFile(file: File) {
    if (!file.name.endsWith(".csv")) {
      setUploadError("Please upload a CSV file.");
      return;
    }
    setUploadError(null);
    const text = await file.text();
    uploadMut.mutate({ csvText: text, filename: file.name });
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  const filtered = useMemo(() => {
    let rows = customers;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(c => c.customer.toLowerCase().includes(q));
    }
    if (severityFilter !== "all") rows = rows.filter(c => c.severity === severityFilter);
    return [...rows].sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      if (sortKey === "customer") { va = a.customer; vb = b.customer; }
      else if (sortKey === "orders") { va = a.orders; vb = b.orders; }
      else if (sortKey === "totalDiscrepancy") { va = a.totalDiscrepancy; vb = b.totalDiscrepancy; }
      else if (sortKey === "discrepancyRate") { va = a.discrepancyRate; vb = b.discrepancyRate; }
      else if (sortKey === "severity") {
        const order = { red: 0, yellow: 1, green: 2 };
        va = order[a.severity as keyof typeof order]; vb = order[b.severity as keyof typeof order];
      }
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
      return sortDir === "asc" ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  }, [customers, search, sortKey, sortDir, severityFilter]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3 text-cyan-400" /> : <ChevronDown className="w-3 h-3 text-cyan-400" />;
  }

  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatHistory(h => [...h, { role: "user", text: msg }]);
    setChatLoading(true);
    try {
      const res = await chatMut.mutateAsync({ message: msg, from: dateFrom, to: dateTo });
      const answer = typeof res.answer === "string" ? res.answer : "Unable to generate a response.";
      setChatHistory(h => [...h, { role: "ai", text: answer }]);
    } catch {
      setChatHistory(h => [...h, { role: "ai", text: "Sorry, I couldn't process that request. Please try again." }]);
    } finally {
      setChatLoading(false);
    }
  }

  const isLoading = statsQ.isLoading || customersQ.isLoading;
  const criticalCount = stats?.criticalCount ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      {/* ── Header ── */}
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-30">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5 text-cyan-400" />
            <span className="font-bold text-foreground tracking-tight">LAZR Discrepancy Agent</span>
            <Badge variant="outline" className="text-xs text-cyan-400 border-cyan-400/40 hidden sm:flex">All Customers</Badge>
          </div>
          <div className="flex items-center gap-2">
            {/* Critical alert badge */}
            {criticalCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-semibold">
                <Bell className="w-3 h-3" />
                {criticalCount} Critical
              </div>
            )}
            {stats?.lastFetched && (
              <span className="text-xs text-muted-foreground hidden lg:block">
                {stats.csvFilename && <span className="text-cyan-400/70 mr-1"><FileText className="w-3 h-3 inline mr-0.5" />{stats.csvFilename}</span>}
                {new Date(stats.lastFetched).toLocaleString()}
              </span>
            )}
            {/* Upload CSV button */}
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={onFileChange} />
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}
              disabled={uploadMut.isPending}
              className="border-cyan-400/40 text-cyan-400 hover:bg-cyan-400/10">
              <Upload className={`w-3.5 h-3.5 mr-1.5 ${uploadMut.isPending ? "animate-pulse" : ""}`} />
              {uploadMut.isPending ? "Loading…" : "Upload CSV"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-5 space-y-5">

        {/* ── Upload error ── */}
        {uploadError && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-400 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {uploadError}
            <button onClick={() => setUploadError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* ── Empty state: no CSV uploaded yet ── */}
        {!isLoading && !hasData && (
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`rounded-lg border-2 border-dashed p-12 text-center cursor-pointer transition-colors ${
              isDragging ? "border-cyan-400 bg-cyan-400/10" : "border-border hover:border-cyan-400/50 hover:bg-cyan-400/5"
            }`}
          >
            <Upload className="w-10 h-10 mx-auto mb-3 text-cyan-400/50" />
            <p className="text-foreground font-semibold mb-1">Upload your LAZR export CSV</p>
            <p className="text-muted-foreground text-sm">Drag & drop or click to browse · CSV files only</p>
            <p className="text-muted-foreground text-xs mt-2">Export your query from LAZR and upload it here to see the discrepancy analysis</p>
          </div>
        )}

        {/* ── Date Range Filter ── */}
        {hasData && (
          <div className="rounded-lg border border-border bg-card p-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="w-3.5 h-3.5 text-cyan-400" />
              <span className="font-semibold text-foreground">Date Range</span>
            </div>
            <div className="flex items-center gap-1.5">
              {PRESETS.map(p => (
                <button key={p.days} onClick={() => applyPreset(p.days)}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                    activePreset === p.days
                      ? "bg-cyan-400/20 border-cyan-400/60 text-cyan-400"
                      : "border-border text-muted-foreground hover:border-cyan-400/40 hover:text-foreground"
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground">From</span>
              <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setActivePreset(0); }}
                className="text-xs bg-input border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-cyan-400/60" />
              <span className="text-xs text-muted-foreground">To</span>
              <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setActivePreset(0); }}
                className="text-xs bg-input border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-cyan-400/60" />
            </div>
          </div>
        )}

        {/* ── KPI Cards ── */}
        {hasData && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard icon={<Users className="w-4 h-4" />} label="Customers" value={isLoading ? "—" : String(stats?.totalCustomers ?? 0)} color="cyan" />
            <KpiCard icon={<BarChart2 className="w-4 h-4" />} label="Total Orders" value={isLoading ? "—" : String(stats?.totalOrders ?? 0)} color="cyan" />
            <KpiCard icon={<DollarSign className="w-4 h-4" />} label="Net Discrepancy"
              value={isLoading ? "—" : `$${(stats?.totalDiscrepancy ?? 0).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} CAD`}
              color={stats && stats.totalDiscrepancy > 0 ? "red" : "green"} />
            <KpiCard icon={<TrendingUp className="w-4 h-4" />} label="Overcharges" value={isLoading ? "—" : String(stats?.totalOvercharges ?? 0)} color="red" />
            <KpiCard icon={<TrendingDown className="w-4 h-4" />} label="Undercharges" value={isLoading ? "—" : String(stats?.totalUndercharges ?? 0)} color="yellow" />
            <KpiCard icon={<CheckCircle className="w-4 h-4" />} label="Avg Disc. Rate" value={isLoading ? "—" : `${(stats?.avgDiscrepancyRate ?? 0).toFixed(1)}%`} color="cyan" />
          </div>
        )}

        {/* ── Main Content ── */}
        {hasData && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

            {/* ── Customer Table ── */}
            <div className="xl:col-span-2 rounded-lg border border-border bg-card overflow-hidden">
              <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center gap-3">
                <h2 className="font-semibold text-foreground flex-1">Customer Discrepancy Breakdown</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  {(["all", "red", "yellow", "green"] as const).map(s => (
                    <button key={s} onClick={() => setSeverityFilter(s)}
                      className={`text-xs px-2 py-1 rounded border transition-colors ${
                        severityFilter === s
                          ? s === "red" ? "bg-red-500/20 border-red-500/60 text-red-400"
                            : s === "yellow" ? "bg-yellow-500/20 border-yellow-500/60 text-yellow-400"
                            : s === "green" ? "bg-green-500/20 border-green-500/60 text-green-400"
                            : "bg-cyan-400/20 border-cyan-400/60 text-cyan-400"
                          : "border-border text-muted-foreground hover:border-border/80"
                      }`}>
                      {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                  <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                    className="w-36 h-7 text-xs bg-input border-border" />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      {([
                        { key: "customer" as SortKey, label: "Customer" },
                        { key: "orders" as SortKey, label: "Orders" },
                        { key: "totalDiscrepancy" as SortKey, label: "Discrepancy (CAD)" },
                        { key: "discrepancyRate" as SortKey, label: "Rate %" },
                        { key: "severity" as SortKey, label: "Severity" },
                      ]).map(col => (
                        <th key={col.key} onClick={() => toggleSort(col.key)}
                          className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap">
                          <span className="flex items-center gap-1">{col.label} <SortIcon k={col.key} /></span>
                        </th>
                      ))}
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i} className="border-b border-border/50">
                          {Array.from({ length: 6 }).map((_, j) => (
                            <td key={j} className="px-4 py-3">
                              <div className="h-4 bg-muted/40 rounded animate-pulse" style={{ width: j === 0 ? "80%" : "60%" }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : filtered.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No customers found</td></tr>
                    ) : (
                      filtered.map((c, i) => (
                        <tr key={c.customer}
                          className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "" : "bg-muted/5"}`}>
                          <td className="px-4 py-2.5 font-medium text-foreground max-w-[200px] truncate" title={c.customer}>{c.customer}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{c.orders.toLocaleString()}</td>
                          <td className={`px-4 py-2.5 font-semibold tabular-nums ${c.totalDiscrepancy > 0 ? "text-red-400" : c.totalDiscrepancy < 0 ? "text-yellow-400" : "text-green-400"}`}>
                            {c.totalDiscrepancy >= 0 ? "+" : ""}${c.totalDiscrepancy.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.discrepancyRate.toFixed(1)}%</td>
                          <td className="px-4 py-2.5">
                            <span className={`severity-${c.severity}`}>
                              {c.severity === "red" ? "⚠ Critical" : c.severity === "yellow" ? "◆ Moderate" : "✓ Minor"}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => navigate(`/customer/${encodeURIComponent(c.customer)}?from=${dateFrom}&to=${dateTo}`)}
                              className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                              <ExternalLink className="w-3 h-3" /> View
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
                Showing {filtered.length} of {customers.length} customers · Red &gt;$500 | Yellow $50–500 | Green &lt;$50
              </div>
            </div>

            {/* ── AI Chat Agent ── */}
            <div className="rounded-lg border border-border bg-card flex flex-col overflow-hidden" style={{ minHeight: "480px" }}>
              <div className="p-4 border-b border-border flex items-center gap-2">
                <Bot className="w-4 h-4 text-cyan-400" />
                <h2 className="font-semibold text-foreground">AI Discrepancy Agent</h2>
                <Badge variant="outline" className="text-xs text-cyan-400 border-cyan-400/40 ml-auto">GPT-4.1</Badge>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: "420px" }}>
                {chatHistory.length === 0 && (
                  <div className="text-center text-muted-foreground text-sm py-4 space-y-3">
                    <Bot className="w-8 h-8 mx-auto text-cyan-400/40" />
                    <p>Ask me anything about billing discrepancies.</p>
                    <div className="space-y-2 text-left">
                      {[
                        "Which customers have the highest overcharges?",
                        "How many critical discrepancies are there?",
                        "What is the total net discrepancy in CAD?",
                      ].map(q => (
                        <button key={q} onClick={() => setChatInput(q)}
                          className="block w-full text-left text-xs px-3 py-2 rounded border border-border hover:border-cyan-400/40 hover:bg-cyan-400/5 transition-colors text-muted-foreground hover:text-foreground">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chatHistory.map((msg, i) => (
                  <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "ai" && <Bot className="w-5 h-5 text-cyan-400 flex-shrink-0 mt-0.5" />}
                    <div className={`rounded-lg px-3 py-2 text-sm max-w-[85%] ${
                      msg.role === "user"
                        ? "bg-cyan-400/20 text-foreground border border-cyan-400/30"
                        : "bg-muted text-foreground border border-border"
                    }`}>
                      {msg.role === "ai" ? <Streamdown>{msg.text}</Streamdown> : msg.text}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex gap-2">
                    <Bot className="w-5 h-5 text-cyan-400 flex-shrink-0 mt-0.5" />
                    <div className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground">
                      <span className="animate-pulse">Analyzing data…</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="p-3 border-t border-border flex gap-2">
                <Input placeholder="Ask about discrepancies…" value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && sendChat()}
                  className="flex-1 text-sm bg-input border-border" disabled={chatLoading} />
                <Button size="sm" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}
                  className="bg-cyan-400/20 text-cyan-400 border border-cyan-400/40 hover:bg-cyan-400/30">
                  <Send className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
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
