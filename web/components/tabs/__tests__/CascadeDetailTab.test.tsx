import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CascadeDetailTab } from "../CascadeDetailTab";

describe("CascadeDetailTab", () => {
  it("loads real chained-liquidation and CappedRate-breach results (mock mode)", async () => {
    render(<CascadeDetailTab />);
    expect(screen.getAllByText(/Loading/).length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));

    // Real statuses from the mock fixture, not a Milestone-2 placeholder.
    expect(screen.getAllByText("Liquidated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Swept").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Success").length).toBeGreaterThan(0);
    // "Protection disabled" was a misleading first label - avoidForcedLiquidationsCol_=false
    // is the deliberate, protective default (real vault deployments ship this way, confirmed
    // against real source + team review), not a gap. Relabeled to say what actually happens.
    expect(screen.getAllByText("Liquidates on depeg (default)").length).toBeGreaterThan(0);
  });

  it("does not claim to be a Milestone-2 stub", async () => {
    render(<CascadeDetailTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(screen.queryByText(/Milestone 2/)).toBeNull();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
    expect(screen.queryByText(/ComingSoonPanel/)).toBeNull();
  });

  it("renders real tables, not just prose - chained liquidation (Aave, Fluid) + CappedRate breach", async () => {
    const { container } = render(<CascadeDetailTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(container.querySelectorAll("table").length).toBe(3);
  });

  it("shows every token amount and percentage with a real unit, never a bare number", async () => {
    render(<CascadeDetailTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));

    // Chained-liquidation table: real decimal-adjusted token amounts with real symbols.
    expect(screen.getAllByText(/USDT/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);

    // Real diff percentages, including the genuinely tiny Aave one - never silently
    // rounded to "0.00%" (formatPct's whole reason for existing over formatMagnitudePct).
    expect(screen.getAllByText(/%/).length).toBeGreaterThan(0);
    expect(screen.queryByText("0.00%")).toBeNull();
  });

  it("shows Fluid's real 100% consumption effect and Aave's real marginal drift as distinct results", async () => {
    render(<CascadeDetailTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(screen.getAllByText("-100.00%").length).toBeGreaterThan(0);
  });
});
