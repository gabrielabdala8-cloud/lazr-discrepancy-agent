import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { pgQuery } from "../pgDb";
import { DISCREPANCY_SQL } from "../discrepancyQuery";
import { invokeLLM } from "../_core/llm";

type OrderRow = {
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

// In-memory cache so the daily job and API share the same data
let cachedRows: OrderRow[] = [];
let lastFetched: Date | null = null;

export async function refreshData(): Promise<void> {
  try {
    cachedRows = await pgQuery<OrderRow>(DISCREPANCY_SQL);
    lastFetched = new Date();
    console.log(`[Discrepancy] Refreshed: ${cachedRows.length} rows at ${lastFetched.toISOString()}`);
  } catch (err) {
    console.error("[Discrepancy] Failed to refresh data:", err);
  }
}

function computeCustomerStats(rows: OrderRow[]) {
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
    discrepancyRate: s.totalSelling > 0 ? (s.totalDiscrepancy / s.totalSelling) * 100 : 0,
    severity: Math.abs(s.totalDiscrepancy) < 50 ? "green"
      : Math.abs(s.totalDiscrepancy) < 500 ? "yellow"
      : "red",
  })).sort((a, b) => Math.abs(b.totalDiscrepancy) - Math.abs(a.totalDiscrepancy));
}

export const discrepancyRouter = router({
  /** Global KPI summary */
  getStats: publicProcedure.query(async () => {
    if (cachedRows.length === 0) await refreshData();

    const stats = computeCustomerStats(cachedRows);
    const totalDiscrepancy = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
    const totalOvercharges = stats.reduce((s, c) => s + c.overcharges, 0);
    const totalUndercharges = stats.reduce((s, c) => s + c.undercharges, 0);
    const totalSelling = stats.reduce((s, c) => s + c.totalSelling, 0);
    const avgDiscRate = totalSelling > 0 ? (totalDiscrepancy / totalSelling) * 100 : 0;

    return {
      totalCustomers: stats.length,
      totalOrders: cachedRows.length,
      totalDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
      totalOvercharges,
      totalUndercharges,
      avgDiscrepancyRate: Math.round(avgDiscRate * 100) / 100,
      lastFetched: lastFetched?.toISOString() ?? null,
    };
  }),

  /** Per-customer breakdown */
  getCustomers: publicProcedure.query(async () => {
    if (cachedRows.length === 0) await refreshData();
    return computeCustomerStats(cachedRows);
  }),

  /** Manual refresh trigger */
  refresh: publicProcedure.mutation(async () => {
    await refreshData();
    return { success: true, rows: cachedRows.length, lastFetched: lastFetched?.toISOString() };
  }),

  /** AI chat agent */
  chat: publicProcedure
    .input(z.object({ message: z.string().min(1).max(1000) }))
    .mutation(async ({ input }) => {
      if (cachedRows.length === 0) await refreshData();

      const stats = computeCustomerStats(cachedRows);
      const totalDisc = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
      const topOvercharged = stats.filter(c => c.totalDiscrepancy > 0).slice(0, 5);
      const topUndercharged = stats.filter(c => c.totalDiscrepancy < 0).slice(0, 5);

      const context = `
You are a logistics billing analyst AI. You have access to the following discrepancy data for the last 6 months:

SUMMARY:
- Total customers: ${stats.length}
- Total orders: ${cachedRows.length}
- Net discrepancy: $${totalDisc.toFixed(2)} CAD
- Total overcharged orders: ${stats.reduce((s, c) => s + c.overcharges, 0)}
- Total undercharged orders: ${stats.reduce((s, c) => s + c.undercharges, 0)}

TOP 5 CUSTOMERS BY OVERCHARGE:
${topOvercharged.map(c => `- ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD over ${c.orders} orders (${c.discrepancyRate.toFixed(1)}% rate)`).join("\n")}

TOP 5 CUSTOMERS BY UNDERCHARGE:
${topUndercharged.map(c => `- ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD over ${c.orders} orders`).join("\n")}

ALL CUSTOMERS (${stats.length} total):
${stats.slice(0, 30).map(c => `- ${c.customer}: ${c.orders} orders, disc=$${c.totalDiscrepancy.toFixed(2)}, rate=${c.discrepancyRate.toFixed(1)}%, severity=${c.severity}`).join("\n")}

Answer the user's question concisely and accurately based on this data. Format monetary values in CAD. Be direct and professional.
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
