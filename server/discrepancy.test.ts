import { describe, it, expect, beforeEach } from "vitest";
import { discrepancyRouter } from "./routers/discrepancy";
import type { TrpcContext } from "./_core/context";

function makeCtx(): TrpcContext {
  return { user: null, req: {} as never, res: {} as never };
}

// Pre-computed sample data matching what the client-side parser would produce
const SAMPLE_STATS = [
  {
    customer: "ACME CORP",
    orders: 2,
    totalSelling: 300,
    totalBilled: 350,
    totalDiscrepancy: 50,
    overcharges: 1,
    undercharges: 0,
    matches: 1,
    discrepancyRate: 16.67,
    severity: "yellow" as const,
  },
  {
    customer: "BETA INC",
    orders: 1,
    totalSelling: 500,
    totalBilled: 450,
    totalDiscrepancy: -50,
    overcharges: 0,
    undercharges: 1,
    matches: 0,
    discrepancyRate: -10,
    severity: "yellow" as const,
  },
];

const SAMPLE_ORDERS = [
  {
    orderNumber: "1001",
    customer: "ACME CORP",
    date: "2025-10-01",
    transportType: "PARCEL",
    serviceType: "Ground",
    carrier: "UPS",
    lane: "QC -> ON",
    originCountry: "CA",
    destCountry: "CA",
    sellingPrice: 100,
    billedPrice: 150,
    discrepancy: 50,
    margin: 50,
    marginPct: 33.33,
    flag: "overcharge" as const,
  },
  {
    orderNumber: "1002",
    customer: "ACME CORP",
    date: "2025-10-02",
    transportType: "PARCEL",
    serviceType: "Ground",
    carrier: "UPS",
    lane: "QC -> ON",
    originCountry: "CA",
    destCountry: "CA",
    sellingPrice: 200,
    billedPrice: 200,
    discrepancy: 0,
    margin: 40,
    marginPct: 20,
    flag: "match" as const,
  },
  {
    orderNumber: "1003",
    customer: "BETA INC",
    date: "2025-10-03",
    transportType: "LTL",
    serviceType: "Standard",
    carrier: "FedEx",
    lane: "ON -> BC",
    originCountry: "CA",
    destCountry: "CA",
    sellingPrice: 500,
    billedPrice: 450,
    discrepancy: -50,
    margin: 50,
    marginPct: 10,
    flag: "undercharge" as const,
  },
];

async function loadSampleData() {
  const caller = discrepancyRouter.createCaller(makeCtx());
  await caller.uploadCSV({
    stats: SAMPLE_STATS,
    orders: SAMPLE_ORDERS,
    totalRows: 3,
    filename: "test.csv",
  });
}

describe("discrepancy.uploadCSV", () => {
  it("loads pre-computed data and returns row count", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const result = await caller.uploadCSV({
      stats: SAMPLE_STATS,
      orders: SAMPLE_ORDERS,
      totalRows: 3,
      filename: "test.csv",
    });
    expect(result.success).toBe(true);
    expect(result.rows).toBe(3);
    expect(result.filename).toBe("test.csv");
  });

  it("clears data correctly", async () => {
    await loadSampleData();
    const caller = discrepancyRouter.createCaller(makeCtx());
    await caller.clearData();
    const stats = await caller.getStats();
    expect(stats.hasData).toBe(false);
    expect(stats.totalOrders).toBe(0);
  });
});

describe("discrepancy.getStats", () => {
  beforeEach(async () => { await loadSampleData(); });

  it("returns correct total customers and orders", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalCustomers).toBe(2);
    expect(stats.totalOrders).toBe(3);
  });

  it("calculates net discrepancy correctly", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    // ACME +50, BETA -50 = net 0
    expect(stats.totalDiscrepancy).toBe(0);
  });

  it("counts overcharges and undercharges", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalOvercharges).toBe(1);
    expect(stats.totalUndercharges).toBe(1);
  });

  it("reports hasData as true after CSV load", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.hasData).toBe(true);
  });
});

describe("discrepancy.getCustomers", () => {
  beforeEach(async () => { await loadSampleData(); });

  it("returns one row per customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const customers = await caller.getCustomers();
    expect(customers).toHaveLength(2);
    expect(customers.map(c => c.customer)).toContain("ACME CORP");
  });

  it("assigns correct severity flags", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const customers = await caller.getCustomers();
    const acme = customers.find(c => c.customer === "ACME CORP");
    expect(acme?.severity).toBe("yellow");
  });
});

describe("discrepancy.getOrdersByCustomer", () => {
  beforeEach(async () => { await loadSampleData(); });

  it("returns only orders for the specified customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    expect(orders).toHaveLength(2);
  });

  it("returns empty array for unknown customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "NONEXISTENT" });
    expect(orders).toHaveLength(0);
  });

  it("flags overcharge, match, undercharge correctly", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const acmeOrders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    expect(acmeOrders.find(o => o.orderNumber === "1001")?.flag).toBe("overcharge");
    expect(acmeOrders.find(o => o.orderNumber === "1002")?.flag).toBe("match");
    const betaOrders = await caller.getOrdersByCustomer({ customer: "BETA INC" });
    expect(betaOrders.find(o => o.orderNumber === "1003")?.flag).toBe("undercharge");
  });

  it("sorts orders by absolute discrepancy descending", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    expect(orders[0].orderNumber).toBe("1001");
  });
});

describe("discrepancy date-range filtering", () => {
  beforeEach(async () => { await loadSampleData(); });

  it("filters orders by from date", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats({ from: "2025-10-02" });
    expect(stats.totalOrders).toBe(2);
  });

  it("filters orders by to date", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats({ to: "2025-10-01" });
    expect(stats.totalOrders).toBe(1);
  });

  it("filters orders by full date range", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats({ from: "2025-10-02", to: "2025-10-02" });
    expect(stats.totalOrders).toBe(1);
  });

  it("returns all orders when no date range provided", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalOrders).toBe(3);
  });
});
