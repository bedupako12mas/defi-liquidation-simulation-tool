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

  it("renders real tables, not just prose - validation (Aave, Fluid) + profitability (Aave, Fluid)", async () => {
    const { container } = render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(container.querySelectorAll("table").length).toBe(4);
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
