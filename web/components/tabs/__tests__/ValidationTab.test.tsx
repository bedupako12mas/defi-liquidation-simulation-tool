import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ValidationTab } from "../ValidationTab";

describe("ValidationTab", () => {
  it("loads real validator results (mock mode) and renders both protocols' tables", async () => {
    render(<ValidationTab />);
    expect(screen.getAllByText(/Loading/).length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));

    // Real statuses from the mock fixture, not a Milestone-2 placeholder.
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByText("Matched (within drift)")).toBeInTheDocument();
    expect(screen.getByText("Unexpected revert")).toBeInTheDocument();
    expect(screen.getAllByText("Swept").length).toBeGreaterThan(0);
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
  });

  it("does not claim to be a Milestone-2 stub", async () => {
    render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(screen.queryByText(/Milestone 2/)).toBeNull();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
  });

  it("renders real tables, not just prose - validation (Aave, Fluid) + profitability (Aave; Fluid is summary-only, see below)", async () => {
    const { container } = render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    // 2 validation tables + 1 Aave profitability table. Fluid's profitability mock is now
    // deliberately all "unable-to-validate" (matching a real deployed run) - it renders a
    // collapsed summary line, not an empty/all-dead table.
    expect(container.querySelectorAll("table").length).toBe(3);
  });

  it("collapses zero-signal profitability rows into a grouped summary instead of one dead row each", async () => {
    render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));

    // Real, grouped counts, not 5 near-identical individual rows.
    expect(screen.getByText(/3 × no sweep within the tested range/)).toBeInTheDocument();
    expect(screen.getByText(/2 × Oracle doesn't expose getOracleHopSources/)).toBeInTheDocument();

    // The HF-specific detail text that used to appear once per row is gone from the
    // collapsed summary (it's stripped during grouping) - never shown as 5 separate lines.
    expect(screen.queryByText(/HF=1\.0959/)).toBeNull();
  });

  it("shows every money/token amount with a real unit, never a bare number", async () => {
    render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));

    // Validation table: real decimal-adjusted token amounts with real symbols.
    expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/wstETH/).length).toBeGreaterThan(0);

    // Profitability table: real dollar figures and real gas units.
    expect(screen.getAllByText(/\$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gas$/).length).toBeGreaterThan(0);

    // Never a bare, unlabeled raw integer for a money/token figure - the old
    // `formatAmount` (BigInt(...).toLocaleString()) with no unit is gone.
    expect(screen.queryByText("120,247,427,417")).toBeNull();
  });

  it("shows a real, correctly-signed net profit for both a profitable and an unprofitable case", async () => {
    render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(screen.getAllByText("Profitable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unprofitable").length).toBeGreaterThan(0);
  });
});
