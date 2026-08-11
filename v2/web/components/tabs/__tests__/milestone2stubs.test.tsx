import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CascadeDetailTab } from "../CascadeDetailTab";
import { ValidationTab } from "../ValidationTab";

/**
 * These tabs must NOT claim to be real Milestone-2 functionality (the task this build came
 * from is explicit: "CascadeDetailTab and ValidationTab as <ComingSoonPanel /> stubs -
 * Milestone 2 isn't built yet, don't pretend it is"). These tests assert that honesty
 * mechanically, not just by convention - render either tab and it must say it isn't built.
 */
describe("Milestone 2 tab stubs", () => {
  it("CascadeDetailTab renders ComingSoonPanel content and lists reserved component names", () => {
    render(<CascadeDetailTab />);
    expect(screen.getAllByText(/Milestone 2/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not built yet/)).toBeInTheDocument();
    expect(screen.getByText("components/cascade/CascadeRoundChart.tsx")).toBeInTheDocument();
    expect(screen.getByText("components/cascade/CappedRateEffectChart.tsx")).toBeInTheDocument();
  });

  it("ValidationTab renders ComingSoonPanel content", () => {
    render(<ValidationTab />);
    expect(screen.getByText(/Milestone 2/)).toBeInTheDocument();
    expect(screen.getByText(/Not built yet/)).toBeInTheDocument();
  });

  it("neither stub renders a chart, table, or any element implying live data", () => {
    const { container: cascadeContainer } = render(<CascadeDetailTab />);
    expect(cascadeContainer.querySelector("table")).toBeNull();
    expect(cascadeContainer.querySelector("svg")).toBeNull();

    const { container: validationContainer } = render(<ValidationTab />);
    expect(validationContainer.querySelector("table")).toBeNull();
    expect(validationContainer.querySelector("svg")).toBeNull();
  });
});
