import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { pgQuery } from "../pgDb";
import { DISCREPANCY_SQL } from "../discrepancyQuery";
import { invokeLLM } from "../_core/llm";
import { notifyOwner } from "../_core/notification";

export type OrderRow = {
  "Order Number": string;
  "Order Status": string;
  "Organization Name": string;
  "Transport Type": string;
  "Service Type": string;
  "Carrier Name": string;
  "Origin Pickup Date": string;
  "Origin Country": string;
  "Destination Country": string;
  "Lane (Origin -> Destination Province)": string;
  "Selling Price (CAD)": string;
  "Billed Selling Price (CAD)": string;
  "Margin (CAD $)": string;
  "Margin (%)": string;
};

// ── In-memory cache ──────────────────────────────────────────────────────────
let cachedRows: OrderRow[] = [];
let lastFetched: Date | null = null;
let lastCriticalCount = 0;

export async function refreshData(): Promise<void> {
  try {
    const rows = await pgQuery<OrderRow>(DISCREPANCY_SQL);
    cachedRows = rows;
    lastFetched = new Date();
    console.log(`[Discrepancy] Refreshed: ${cachedRows.length} rows at ${lastFetched.toISOString()}`);

    // ── Critical alert: notify owner when new red discrepancies appear ────────
    const stats = computeCustomerStats(rows);
    const criticalCustomers = stats.filter(c => c.severity === "red");
    const currentCriticalCount = criticalCustomers.length;

    if (currentCriticalCount > lastCriticalCount && lastCriticalCount >= 0) {
      const newCritical = criticalCustomers.slice(0, 5);
      const alertLines = newCritical
        .map(c => `• ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD (${c.orders} orders)`)
        .join("\n");

      await notifyOwner({
        title: `⚠ ${currentCriticalCount} Critical Billing Discrepanc${currentCriticalCount === 1 ? "y" : "ies"} Detected`,
        content: `The daily refresh found ${currentCriticalCount} customer(s) with critical billing discrepancies (>$500 CAD).\n\nTop offenders:\n${alertLines}\n\nRefreshed at: ${lastFetched.toISOString()}`,
      });
      console.log(`[Discrepancy] Alert sent: ${currentCriticalCount} critical customers`);
    }
    lastCriticalCount = currentCriticalCount;
  } catch (err) {
    console.error("[Discrepancy] Failed to refresh data:", err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function filterByDateRange(rows: OrderRow[], from?: string, to?: string): OrderRow[] {
  if (!from && !to) return rows;
  return rows.filter(row => {
    const d = row["Origin Pickup Date"];
    if (!d) return true;
    const date = d.substring(0, 10); // YYYY-MM-DD
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

export function computeCustomerStats(rows: OrderRow[]) {
  const map = new Map<string, {
    customer: string;
    orders: number;
    totalSelling: number;
    totalBilled: number;
    totalDiscrepancy: number;
    overcharges: number;
    undercharges: number;
    matches: number;
  }>();

  for (const row of rows) {
    const customer = row["Organization Name"] || "Unknown";
    const selling = parseFloat(row["Selling Price (CAD)"] ?? "0") || 0;
    const billed = parseFloat(row["Billed Selling Price (CAD)"] ?? "0") || 0;
    const disc = billed - selling;

    if (!map.has(customer)) {
      map.set(customer, { customer, orders: 0, totalSelling: 0, totalBilled: 0, totalDiscrepancy: 0, overcharges: 0, undercharges: 0, matches: 0 });
    }
    const s = map.get(customer)!;
    s.orders++;
    s.totalSelling += selling;
    s.totalBilled += billed;
    s.totalDiscrepancy += disc;
    if (disc > 0.01) s.overcharges++;
    else if (disc < -0.01) s.undercharges++;
    else s.matches++;
  }

  return Array.from(map.values()).map(s => ({
    ...s,
    totalDiscrepancy: Math.round(s.totalDiscrepancy * 100) / 100,
    discrepancyRate: s.totalSelling > 0 ? (s.totalDiscrepancy / s.totalSelling) * 100 : 0,
    severity: (Math.abs(s.totalDiscrepancy) < 50 ? "green"
      : Math.abs(s.totalDiscrepancy) < 500 ? "yellow"
      : "red") as "red" | "yellow" | "green",
  })).sort((a, b) => Math.abs(b.totalDiscrepancy) - Math.abs(a.totalDiscrepancy));
}

// ── Date range input schema ───────────────────────────────────────────────────
const dateRangeInput = z.object({
  from: z.string().optional(), // YYYY-MM-DD
  to: z.string().optional(),
}).optional();

// ── Router ────────────────────────────────────────────────────────────────────
export const discrepancyRouter = router({

  /** Global KPI summary — supports optional date range */
  getStats: publicProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      if (cachedRows.length === 0) await refreshData();
      const rows = filterByDateRange(cachedRows, input?.from, input?.to);
      const stats = computeCustomerStats(rows);
      const totalDiscrepancy = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
      const totalSelling = stats.reduce((s, c) => s + c.totalSelling, 0);

      return {
        totalCustomers: stats.length,
        totalOrders: rows.length,
        totalDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
        totalOvercharges: stats.reduce((s, c) => s + c.overcharges, 0),
        totalUndercharges: stats.reduce((s, c) => s + c.undercharges, 0),
        avgDiscrepancyRate: totalSelling > 0 ? Math.round((totalDiscrepancy / totalSelling) * 10000) / 100 : 0,
        criticalCount: stats.filter(c => c.severity === "red").length,
        lastFetched: lastFetched?.toISOString() ?? null,
      };
    }),

  /** Per-customer breakdown — supports optional date range */
  getCustomers: publicProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      if (cachedRows.length === 0) await refreshData();
      const rows = filterByDateRange(cachedRows, input?.from, input?.to);
      return computeCustomerStats(rows);
    }),

  /** Per-customer order-level breakdown for drill-down page */
  getOrdersByCustomer: publicProcedure
    .input(z.object({
      customer: z.string().min(1),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .query(async ({ input }) => {
      if (cachedRows.length === 0) await refreshData();
      const rows = filterByDateRange(cachedRows, input.from, input.to)
        .filter(r => r["Organization Name"] === input.customer);

      return rows.map(r => {
        const selling = parseFloat(r["Selling Price (CAD)"] ?? "0") || 0;
        const billed = parseFloat(r["Billed Selling Price (CAD)"] ?? "0") || 0;
        const disc = billed - selling;
        return {
          orderNumber: r["Order Number"],
          date: r["Origin Pickup Date"]?.substring(0, 10) ?? "",
          transportType: r["Transport Type"],
          serviceType: r["Service Type"],
          carrier: r["Carrier Name"],
          lane: r["Lane (Origin -> Destination Province)"],
          originCountry: r["Origin Country"],
          destCountry: r["Destination Country"],
          sellingPrice: selling,
          billedPrice: billed,
          discrepancy: Math.round(disc * 100) / 100,
          margin: parseFloat(r["Margin (CAD $)"] ?? "0") || 0,
          marginPct: parseFloat(r["Margin (%)"] ?? "0") || 0,
          flag: disc > 0.01 ? "overcharge" : disc < -0.01 ? "undercharge" : "match",
        };
      }).sort((a, b) => Math.abs(b.discrepancy) - Math.abs(a.discrepancy));
    }),

  /** Manual refresh trigger */
  refresh: publicProcedure.mutation(async () => {
    await refreshData();
    return { success: true, rows: cachedRows.length, lastFetched: lastFetched?.toISOString() };
  }),

  /** AI chat agent */
  chat: publicProcedure
    .input(z.object({
      message: z.string().min(1).max(1000),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      if (cachedRows.length === 0) await refreshData();
      const rows = filterByDateRange(cachedRows, input.from, input.to);
      const stats = computeCustomerStats(rows);
      const totalDisc = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
      const topOvercharged = stats.filter(c => c.totalDiscrepancy > 0).slice(0, 5);
      const topUndercharged = stats.filter(c => c.totalDiscrepancy < 0).slice(0, 5);
      const dateContext = input.from || input.to
        ? `Date range: ${input.from ?? "start"} to ${input.to ?? "today"}`
        : "Date range: last 6 months (all data)";

      const context = `
You are a logistics billing analyst AI. You have access to the following discrepancy data.
${dateContext}

SUMMARY:
- Total customers: ${stats.length}
- Total orders: ${rows.length}
- Net discrepancy: $${totalDisc.toFixed(2)} CAD
- Critical (>$500): ${stats.filter(c => c.severity === "red").length} customers
- Moderate ($50-500): ${stats.filter(c => c.severity === "yellow").length} customers
- Minor (<$50): ${stats.filter(c => c.severity === "green").length} customers
- Total overcharged orders: ${stats.reduce((s, c) => s + c.overcharges, 0)}
- Total undercharged orders: ${stats.reduce((s, c) => s + c.undercharges, 0)}

TOP 5 BY OVERCHARGE:
${topOvercharged.map(c => `- ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD over ${c.orders} orders (${c.discrepancyRate.toFixed(1)}% rate)`).join("\n")}

TOP 5 BY UNDERCHARGE:
${topUndercharged.map(c => `- ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD over ${c.orders} orders`).join("\n")}

ALL CUSTOMERS (${stats.length} total):
${stats.slice(0, 40).map(c => `- ${c.customer}: ${c.orders} orders, disc=$${c.totalDiscrepancy.toFixed(2)}, rate=${c.discrepancyRate.toFixed(1)}%, severity=${c.severity}`).join("\n")}

Answer concisely and accurately. Format monetary values in CAD. Be direct and professional.
      `.trim();

      const response = await invokeLLM({
        messages: [
          { role: "system", content: context },
          { role: "user", content: input.message },
        ],
      });

      return {
        answer: response.choices[0]?.message?.content ?? "Unable to generate a response.",
      };
    }),
});
