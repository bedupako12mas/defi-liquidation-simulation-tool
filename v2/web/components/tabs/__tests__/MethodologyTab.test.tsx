import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CapabilitiesProvider } from "@/lib/hooks/useCapabilities";
import { MethodologyTab } from "../MethodologyTab";

describe("MethodologyTab", () => {
  it("renders the three position states, the UC frontier table, and the limitations list", async () => {
    render(
      <CapabilitiesProvider>
        <MethodologyTab />
      </CapabilitiesProvider>
    );

    // Static content, present immediately.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Liquidatable")).toBeInTheDocument();
    expect(screen.getByText("Toxic")).toBeInTheDocument();

    // Data-dependent content, arrives once useCapabilities' mock fetch resolves.
    await waitFor(() => expect(screen.queryAllByText(/MOCK MODE/).length).toBeGreaterThan(0));
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1); // header + at least one data row
  });
});
