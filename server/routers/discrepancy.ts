import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { notifyOwner } from "../_core/notification";

// ── Types ─────────────────────────────────────────────────────────────────────
export type CustomerStat = {
  customer: string;
  orders: number;
  totalSelling: number;
  totalBilled: number;
  totalDiscrepancy: number;
  overcharges: number;
  undercharges: number;
  matches: number;
  discrepancyRate: number;
  severity: "red" | "yellow" | "green";
};

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

// ── In-memory cache ───────────────────────────────────────────────────────────
// Stores pre-computed stats sent from the client (CSV parsed in browser)
let cachedStats: CustomerStat[] = [];
let cachedOrders: FlatOrder[] = [];
let lastFetched: Date | null = null;
let lastCriticalCount = 0;
let csvFilename: string | null = null;
let totalOrderCount = 0;

// ── Flat order type (client-side parsed) ─────────────────────────────────────
type FlatOrder = {
  orderNumber: string;
  customer: string;
  date: string;
  transportType: string;
  serviceType: string;
  carrier: string;
  lane: string;
  originCountry: string;
  destCountry: string;
  sellingPrice: number;
  billedPrice: number;
  discrepancy: number;
  margin: number;
  marginPct: number;
  flag: "overcharge" | "undercharge" | "match";
};

// ── Zod schemas ───────────────────────────────────────────────────────────────
const customerStatSchema = z.object({
  customer: z.string(),
  orders: z.number(),
  totalSelling: z.number(),
  totalBilled: z.number(),
  totalDiscrepancy: z.number(),
  overcharges: z.number(),
  undercharges: z.number(),
  matches: z.number(),
  discrepancyRate: z.number(),
  severity: z.enum(["red", "yellow", "green"]),
});

const orderRowSchema = z.object({
  orderNumber: z.string(),
  customer: z.string(),
  date: z.string(),
  transportType: z.string(),
  serviceType: z.string(),
  carrier: z.string(),
  lane: z.string(),
  originCountry: z.string(),
  destCountry: z.string(),
  sellingPrice: z.number(),
  billedPrice: z.number(),
  discrepancy: z.number(),
  margin: z.number(),
  marginPct: z.number(),
  flag: z.enum(["overcharge", "undercharge", "match"]),
});

const dateRangeInput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
}).optional();

// ── Router ────────────────────────────────────────────────────────────────────
export const discrepancyRouter = router({

  /** Global KPI summary */
  getStats: publicProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      // Filter orders by date if provided
      let stats = cachedStats;
      if (input?.from || input?.to) {
        const filteredOrders = cachedOrders.filter(o => {
          const d = o.date;
          if (input.from && d < input.from) return false;
          if (input.to && d > input.to) return false;
          return true;
        });
        stats = computeStatsFromOrders(filteredOrders);
      }

      const totalDiscrepancy = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
      const totalSelling = stats.reduce((s, c) => s + c.totalSelling, 0);
      const filteredOrderCount = (input?.from || input?.to)
        ? cachedOrders.filter(o => {
            if (input?.from && o.date < input.from) return false;
            if (input?.to && o.date > input.to) return false;
            return true;
          }).length
        : totalOrderCount;

      return {
        totalCustomers: stats.length,
        totalOrders: filteredOrderCount,
        totalDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
        totalOvercharges: stats.reduce((s, c) => s + c.overcharges, 0),
        totalUndercharges: stats.reduce((s, c) => s + c.undercharges, 0),
        avgDiscrepancyRate: totalSelling > 0 ? Math.round((totalDiscrepancy / totalSelling) * 10000) / 100 : 0,
        criticalCount: stats.filter(c => c.severity === "red").length,
        lastFetched: lastFetched?.toISOString() ?? null,
        csvFilename,
        hasData: cachedStats.length > 0,
      };
    }),

  /** Per-customer breakdown */
  getCustomers: publicProcedure
    .input(dateRangeInput)
    .query(async ({ input }) => {
      if (input?.from || input?.to) {
        const filteredOrders = cachedOrders.filter(o => {
          if (input.from && o.date < input.from) return false;
          if (input.to && o.date > input.to) return false;
          return true;
        });
        return computeStatsFromOrders(filteredOrders);
      }
      return cachedStats;
    }),

  /** Per-customer order-level breakdown */
  getOrdersByCustomer: publicProcedure
    .input(z.object({
      customer: z.string().min(1),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .query(async ({ input }) => {
      return cachedOrders
        .filter(o => {
          if (o.customer !== input.customer) return false;
          if (input.from && o.date < input.from) return false;
          if (input.to && o.date > input.to) return false;
          return true;
        })
        .sort((a, b) => Math.abs(b.discrepancy) - Math.abs(a.discrepancy));
    }),

  /** Upload pre-computed stats from client-side CSV parsing */
  uploadCSV: publicProcedure
    .input(z.object({
      stats: z.array(customerStatSchema),
      orders: z.array(orderRowSchema),
      filename: z.string().optional(),
      totalRows: z.number(),
    }))
    .mutation(async ({ input }) => {
      cachedStats = input.stats;
      cachedOrders = input.orders as FlatOrder[];
      totalOrderCount = input.totalRows;
      lastFetched = new Date();
      csvFilename = input.filename ?? "uploaded.csv";

      console.log(`[Discrepancy] Loaded ${input.totalRows} rows, ${input.stats.length} customers from ${csvFilename}`);

      // Alert owner on new critical discrepancies
      const criticalCustomers = input.stats.filter(c => c.severity === "red");
      const currentCriticalCount = criticalCustomers.length;

      if (currentCriticalCount > lastCriticalCount && lastCriticalCount >= 0) {
        const newCritical = criticalCustomers.slice(0, 5);
        const alertLines = newCritical
          .map(c => `• ${c.customer}: $${c.totalDiscrepancy.toFixed(2)} CAD (${c.orders} orders)`)
          .join("\n");

        await notifyOwner({
          title: `⚠ ${currentCriticalCount} Critical Billing Discrepanc${currentCriticalCount === 1 ? "y" : "ies"} Detected`,
          content: `CSV upload found ${currentCriticalCount} customer(s) with critical billing discrepancies (>$500 CAD).\n\nTop offenders:\n${alertLines}\n\nLoaded at: ${lastFetched.toISOString()}`,
        });
      }
      lastCriticalCount = currentCriticalCount;

      return {
        success: true,
        rows: input.totalRows,
        customers: input.stats.length,
        lastFetched: lastFetched.toISOString(),
        filename: csvFilename,
      };
    }),

  /** Clear loaded data */
  clearData: publicProcedure.mutation(() => {
    cachedStats = [];
    cachedOrders = [];
    totalOrderCount = 0;
    lastFetched = null;
    csvFilename = null;
    lastCriticalCount = 0;
    return { success: true };
  }),

  /** AI chat agent */
  chat: publicProcedure
    .input(z.object({
      message: z.string().min(1).max(1000),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      let stats = cachedStats;
      if (input.from || input.to) {
        const filteredOrders = cachedOrders.filter((o) => {
          if (input.from && o.date < input.from) return false;
          if (input.to && o.date > input.to) return false;
          return true;
        });
        stats = computeStatsFromOrders(filteredOrders);
      }

      const totalDisc = stats.reduce((s, c) => s + c.totalDiscrepancy, 0);
      const topOvercharged = stats.filter(c => c.totalDiscrepancy > 0).slice(0, 5);
      const topUndercharged = stats.filter(c => c.totalDiscrepancy < 0).slice(0, 5);
      const dateContext = input.from || input.to
        ? `Date range: ${input.from ?? "start"} to ${input.to ?? "today"}`
        : "Date range: all data";

      const context = `
You are a logistics billing analyst AI. You have access to the following discrepancy data.
${dateContext}

SUMMARY:
- Total customers: ${stats.length}
- Total orders: ${totalOrderCount}
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

// ── Helper: compute stats from flat order list ────────────────────────────────
function computeStatsFromOrders(orders: any[]): CustomerStat[] {
  const map = new Map<string, CustomerStat>();

  for (const o of orders) {
    const customer = o.customer || "Unknown";
    if (!map.has(customer)) {
      map.set(customer, {
        customer, orders: 0, totalSelling: 0, totalBilled: 0,
        totalDiscrepancy: 0, overcharges: 0, undercharges: 0, matches: 0,
        discrepancyRate: 0, severity: "green",
      });
    }
    const s = map.get(customer)!;
    s.orders++;
    s.totalSelling += o.sellingPrice ?? 0;
    s.totalBilled += o.billedPrice ?? 0;
    s.totalDiscrepancy += o.discrepancy ?? 0;
    if (o.flag === "overcharge") s.overcharges++;
    else if (o.flag === "undercharge") s.undercharges++;
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

// Keep legacy export for tests
export function parseCSV(text: string): OrderRow[] { return []; }
export function computeCustomerStats(rows: OrderRow[]): CustomerStat[] { return []; }
