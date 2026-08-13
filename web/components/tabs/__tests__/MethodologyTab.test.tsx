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

    // Static content, present immediately. Scoped to the state tags specifically - the
    // methodology prose also uses these words in running text (e.g. explaining why Fluid
    // is labeled "Eligible" instead of "Liquidatable"), so a bare text match is ambiguous.
    expect(document.querySelector(".tag-healthy")).toHaveTextContent("Healthy");
    expect(document.querySelector(".tag-liquidatable")).toHaveTextContent("Liquidatable");
    expect(document.querySelector(".tag-eligible")).toHaveTextContent("Eligible");
    expect(document.querySelector(".tag-toxic")).toHaveTextContent("Toxic");

    // Data-dependent content, arrives once useCapabilities' mock fetch resolves.
    await waitFor(() => expect(screen.queryAllByText(/MOCK MODE/).length).toBeGreaterThan(0));
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1); // header + at least one data row
  });
});
