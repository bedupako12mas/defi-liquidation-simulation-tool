import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UcFrontierTable } from "../overview/UcFrontierTable";

describe("UcFrontierTable", () => {
  it("renders one row per input and tags cited vs illustrative provenance", () => {
    render(
      <UcFrontierTable
        rows={[
          {
            protocol: "aave",
            asset: "USDC",
            incentivePct: 4.5,
            ucFrontierPct: 95.69,
            liquidationThresholdPct: 89,
            provenance: "cited: live Aave V3 PoolDataProvider.getReserveConfigurationData(USDC)",
          },
          {
            protocol: "fluid",
            asset: "WSTETH",
            incentivePct: 0.1,
            ucFrontierPct: 99.9,
            liquidationThresholdPct: 95,
            provenance: "illustrative: not on-chain verified",
          },
        ]}
      />
    );

    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("WSTETH")).toBeInTheDocument();
    expect(screen.getByText("cited")).toBeInTheDocument();
    expect(screen.getByText("illustrative")).toBeInTheDocument();
    // Headroom = ucFrontierPct - liquidationThresholdPct, computed in the component itself.
    expect(screen.getByText("6.69 pts")).toBeInTheDocument();
  });
});
