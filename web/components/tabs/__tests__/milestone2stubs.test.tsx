import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CascadeDetailTab } from "../CascadeDetailTab";

/**
 * CascadeDetailTab must NOT claim to be real Milestone-2 functionality (mainnet-fork tier,
 * #37/#38, not built yet - don't pretend it is). ValidationTab moved out of this file once
 * #30/#36 made it real (see ValidationTab.test.tsx) - it is real, RPC-tier functionality
 * now, not a Milestone-2 stub, and asserting it says "Not built yet" would itself be false.
 */
describe("Milestone 2 tab stubs", () => {
  it("CascadeDetailTab renders ComingSoonPanel content and lists reserved component names", () => {
    render(<CascadeDetailTab />);
    expect(screen.getAllByText(/Milestone 2/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not built yet/)).toBeInTheDocument();
    expect(screen.getByText("components/cascade/CascadeRoundChart.tsx")).toBeInTheDocument();
    expect(screen.getByText("components/cascade/CappedRateEffectChart.tsx")).toBeInTheDocument();
  });

  it("does not render a chart, table, or any element implying live data", () => {
    const { container } = render(<CascadeDetailTab />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
