import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Glossary } from "../shared/Glossary";

describe("Glossary", () => {
  it("covers every metric shown across the app, not just position-state terms", () => {
    render(<Glossary />);
    // One from each real section - position states, comparison metrics, validation
    // statuses, and profitability, so a regression that drops a whole section fails loudly.
    expect(screen.getByText("Health factor (HF)")).toBeInTheDocument();
    expect(screen.getByText("Concentration")).toBeInTheDocument();
    expect(screen.getByText("Matched / Matched (within drift)")).toBeInTheDocument();
    expect(screen.getByText("Net profit")).toBeInTheDocument();
  });

  it("gives every term both a plain-language and a technical definition", () => {
    render(<Glossary />);
    expect(screen.getByText(/A single number for how safe a position is/)).toBeInTheDocument();
    expect(screen.getByText(/Collateral value × liquidation threshold/)).toBeInTheDocument();
  });
});
