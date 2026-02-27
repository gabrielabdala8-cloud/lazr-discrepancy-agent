import { describe, it, expect, beforeEach } from "vitest";
import { discrepancyRouter, parseCSV, loadCSVData } from "./routers/discrepancy";
import type { TrpcContext } from "./_core/context";

const SAMPLE_CSV = `"Order Number","Order Status","Organization Name","Transport Type","Service Type","Carrier Name","Origin Pickup Date","Origin Country","Destination Country","Lane (Origin -> Destination Province)","Selling Price (CAD)","Billed Selling Price (CAD)","Margin (CAD $)","Margin (%)"
"1001","DISPATCHED","ACME CORP","PARCEL","Ground","UPS","2025-10-01","CA","CA","QC -> ON","100.00","150.00","50.00","33.33"
"1002","DISPATCHED","ACME CORP","PARCEL","Ground","UPS","2025-10-02","CA","CA","QC -> ON","200.00","200.00","40.00","20.00"
"1003","DISPATCHED","BETA INC","LTL","Standard","FedEx","2025-10-03","CA","CA","ON -> BC","500.00","450.00","50.00","10.00"`;

function makeCtx(): TrpcContext {
  return { user: null, req: {} as never, res: {} as never };
}

describe("parseCSV", () => {
  it("parses header and data rows correctly", () => {
    const rows = parseCSV(SAMPLE_CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]["Order Number"]).toBe("1001");
    expect(rows[0]["Organization Name"]).toBe("ACME CORP");
    expect(rows[0]["Selling Price (CAD)"]).toBe("100.00");
  });
  it("returns empty array for empty input", () => {
    expect(parseCSV("")).toHaveLength(0);
  });
  it("handles quoted fields with commas", () => {
    const csv = `"Name","Value"\n"ACME, INC","100.00"`;
    const rows = parseCSV(csv);
    expect(rows[0]["Name"]).toBe("ACME, INC");
  });
});

describe("discrepancy.getStats", () => {
  beforeEach(async () => { await loadCSVData(SAMPLE_CSV, "test.csv"); });
  it("returns correct total customers and orders", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalCustomers).toBe(2);
    expect(stats.totalOrders).toBe(3);
  });
  it("calculates net discrepancy correctly", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
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
  beforeEach(async () => { await loadCSVData(SAMPLE_CSV, "test.csv"); });
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
  beforeEach(async () => { await loadCSVData(SAMPLE_CSV, "test.csv"); });
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
  beforeEach(async () => { await loadCSVData(SAMPLE_CSV, "test.csv"); });
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

describe("discrepancy.uploadCSV", () => {
  it("loads CSV data and returns row count", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const result = await caller.uploadCSV({ csvText: SAMPLE_CSV, filename: "test.csv" });
    expect(result.success).toBe(true);
    expect(result.rows).toBe(3);
    expect(result.filename).toBe("test.csv");
  });
  it("clears data correctly", async () => {
    await loadCSVData(SAMPLE_CSV, "test.csv");
    const caller = discrepancyRouter.createCaller(makeCtx());
    await caller.clearData();
    const stats = await caller.getStats();
    expect(stats.hasData).toBe(false);
    expect(stats.totalOrders).toBe(0);
  });
});
