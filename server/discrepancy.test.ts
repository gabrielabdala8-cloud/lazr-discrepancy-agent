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
