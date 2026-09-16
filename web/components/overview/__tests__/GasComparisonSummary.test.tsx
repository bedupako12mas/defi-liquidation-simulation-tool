import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { GasComparisonSummary } from "../GasComparisonSummary";

describe("GasComparisonSummary", () => {
  it("shows Aave V3's real gas/profit signal and discloses Fluid T1 has none at this preset (mock mode)", async () => {
    render(<GasComparisonSummary presetId="correlated" />);
    expect(screen.getByText(/Loading gas\/profitability data/)).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByText(/Loading gas\/profitability data/)).toBeNull());

    expect(screen.getByText("Aave V3")).toBeInTheDocument();
    expect(screen.getByText("Fluid T1")).toBeInTheDocument();
    expect(screen.getByText("Median gas cost")).toBeInTheDocument();
    expect(screen.getByText("Median net profit")).toBeInTheDocument();
    // The mock fixture's Fluid rows are all "unable-to-validate" for this preset - a real,
    // disclosed scope limit, not a hidden gap.
    expect(screen.getByText(/No real economic signal yet at this shock preset\./)).toBeInTheDocument();
  });

  it("discloses Aave V4 isn't covered rather than silently omitting it", async () => {
    render(<GasComparisonSummary presetId="correlated" />);
    await waitFor(() => expect(screen.queryByText(/Loading gas\/profitability data/)).toBeNull());
    expect(screen.getByText(/Aave V4 gas estimates aren.t wired up yet/)).toBeInTheDocument();
    expect(screen.queryByText("Aave V4")).toBeNull();
  });
});
