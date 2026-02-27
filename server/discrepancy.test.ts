import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pgDb before importing the router
vi.mock("./pgDb", () => ({
  pgQuery: vi.fn(),
}));

// Mock node-cron to avoid scheduling in tests
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn(),
}));

import { pgQuery } from "./pgDb";
import { discrepancyRouter } from "./routers/discrepancy";
import type { TrpcContext } from "./_core/context";

const mockPgQuery = vi.mocked(pgQuery);

const mockRows = [
  {
    "Order Number": "1001",
    "Order Status": "DISPATCHED",
    "Organization Name": "ACME CORP",
    "Transport Type": "PARCEL",
    "Service Type": "Ground",
    "Carrier Name": "UPS",
    "Origin Pickup Date": "2025-10-01",
    "Origin Country": "CA",
    "Destination Country": "CA",
    "Lane (Origin -> Destination Province)": "QC -> ON",
    "Selling Price (CAD)": "100.00",
    "Billed Selling Price (CAD)": "150.00",
    "Margin (CAD $)": "50.00",
    "Margin (%)": "33.33",
  },
  {
    "Order Number": "1002",
    "Order Status": "DISPATCHED",
    "Organization Name": "ACME CORP",
    "Transport Type": "PARCEL",
    "Service Type": "Ground",
    "Carrier Name": "UPS",
    "Origin Pickup Date": "2025-10-02",
    "Origin Country": "CA",
    "Destination Country": "CA",
    "Lane (Origin -> Destination Province)": "QC -> ON",
    "Selling Price (CAD)": "200.00",
    "Billed Selling Price (CAD)": "200.00",
    "Margin (CAD $)": "40.00",
    "Margin (%)": "20.00",
  },
  {
    "Order Number": "1003",
    "Order Status": "DISPATCHED",
    "Organization Name": "BETA INC",
    "Transport Type": "LTL",
    "Service Type": "Standard",
    "Carrier Name": "FedEx",
    "Origin Pickup Date": "2025-10-03",
    "Origin Country": "CA",
    "Destination Country": "US",
    "Lane (Origin -> Destination Province)": "ON -> NY",
    "Selling Price (CAD)": "500.00",
    "Billed Selling Price (CAD)": "450.00",
    "Margin (CAD $)": "80.00",
    "Margin (%)": "17.78",
  },
];

function makeCtx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("discrepancy.getStats", () => {
  beforeEach(() => {
    mockPgQuery.mockResolvedValue(mockRows as never);
  });

  it("returns correct total customers and orders", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalCustomers).toBe(2);
    expect(stats.totalOrders).toBe(3);
  });

  it("calculates net discrepancy correctly", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    // ACME: (150-100) + (200-200) = 50; BETA: (450-500) = -50; net = 0
    expect(stats.totalDiscrepancy).toBe(0);
  });

  it("counts overcharges and undercharges", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalOvercharges).toBe(1);
    expect(stats.totalUndercharges).toBe(1);
  });
});

describe("discrepancy.getCustomers", () => {
  beforeEach(() => {
    mockPgQuery.mockResolvedValue(mockRows as never);
  });

  it("returns one row per customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const customers = await caller.getCustomers();
    expect(customers).toHaveLength(2);
    const names = customers.map(c => c.customer);
    expect(names).toContain("ACME CORP");
    expect(names).toContain("BETA INC");
  });

  it("assigns correct severity flags", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const customers = await caller.getCustomers();
    const acme = customers.find(c => c.customer === "ACME CORP");
    // ACME total discrepancy = $50 → yellow (50-500)
    expect(acme?.severity).toBe("yellow");
  });
});

describe("discrepancy.getOrdersByCustomer", () => {
  beforeEach(() => {
    mockPgQuery.mockResolvedValue(mockRows as never);
  });

  it("returns only orders for the specified customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    expect(orders).toHaveLength(2);
    expect(orders.every(o => o.orderNumber === "1001" || o.orderNumber === "1002")).toBe(true);
  });

  it("returns empty array for unknown customer", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "NONEXISTENT" });
    expect(orders).toHaveLength(0);
  });

  it("flags overcharge correctly on order level", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    const ord1001 = orders.find(o => o.orderNumber === "1001");
    expect(ord1001?.flag).toBe("overcharge");
    expect(ord1001?.discrepancy).toBe(50);
  });

  it("flags match correctly on order level", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    const ord1002 = orders.find(o => o.orderNumber === "1002");
    expect(ord1002?.flag).toBe("match");
    expect(ord1002?.discrepancy).toBe(0);
  });

  it("flags undercharge correctly on order level", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "BETA INC" });
    const ord1003 = orders.find(o => o.orderNumber === "1003");
    expect(ord1003?.flag).toBe("undercharge");
    expect(ord1003?.discrepancy).toBe(-50);
  });

  it("sorts orders by absolute discrepancy descending", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const orders = await caller.getOrdersByCustomer({ customer: "ACME CORP" });
    // ORD-1001 has disc=50, ORD-1002 has disc=0 → 1001 should be first
    expect(orders[0].orderNumber).toBe("1001");
  });
});

describe("discrepancy date-range filtering", () => {
  beforeEach(() => {
    mockPgQuery.mockResolvedValue(mockRows as never);
  });

  it("filters orders by from date", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    // Only rows on or after 2025-10-02
    const stats = await caller.getStats({ from: "2025-10-02" });
    expect(stats.totalOrders).toBe(2); // rows 1002 and 1003
  });

  it("filters orders by to date", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    // Only rows on or before 2025-10-01
    const stats = await caller.getStats({ to: "2025-10-01" });
    expect(stats.totalOrders).toBe(1); // only row 1001
  });

  it("filters orders by full date range", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats({ from: "2025-10-02", to: "2025-10-02" });
    expect(stats.totalOrders).toBe(1); // only row 1002
  });

  it("returns all orders when no date range provided", async () => {
    const caller = discrepancyRouter.createCaller(makeCtx());
    const stats = await caller.getStats();
    expect(stats.totalOrders).toBe(3);
  });
});
