import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Glossary } from "../shared/Glossary";

describe("Glossary", () => {
  it("covers every metric shown across the app, not just position-state terms", () => {
    render(<Glossary />);
    // One from each real section - position states, comparison metrics, validation
    // statuses, profitability, and the mainnet-fork tier - so a regression that drops a
    // whole section fails loudly.
    expect(screen.getByText("Health factor (HF)")).toBeInTheDocument();
    expect(screen.getByText("Concentration")).toBeInTheDocument();
    expect(screen.getByText("Matched / Matched (within drift)")).toBeInTheDocument();
    expect(screen.getByText("Net profit")).toBeInTheDocument();
    expect(screen.getByText("Real diff / Real diff (%)")).toBeInTheDocument();
  });

  it("gives every term both a plain-language and a technical definition", () => {
    render(<Glossary />);
    expect(screen.getByText(/A single number for how safe a position is/)).toBeInTheDocument();
    expect(screen.getByText(/Empirically checked against Aave's own on-chain/)).toBeInTheDocument();
  });

  it("shows the formula for metrics that have one, and an em dash for qualitative entries that don't", () => {
    render(<Glossary />);
    expect(screen.getByText("HF = (collateral value × liquidation threshold) / debt value")).toBeInTheDocument();
    expect(screen.getByText("net profit USD = bonusValueUsd − debtClearedUsd − gasCostUsd")).toBeInTheDocument();
    // "Swept" is a status label, not a computed metric - no formula.
    const sweptRow = screen.getByText("Swept").closest("tr");
    expect(sweptRow).not.toBeNull();
    expect(sweptRow!.textContent).toContain("—");
  });

  it("gives each row a stable anchor id matching InfoTooltip's glossaryId values", () => {
    render(<Glossary />);
    expect(document.getElementById("hf")).not.toBeNull();
    expect(document.getElementById("uc-frontier")).not.toBeNull();
    expect(document.getElementById("gas-cost")).not.toBeNull();
  });

  it("scrolls to and highlights the row matching activeAnchor", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<Glossary activeAnchor="concentration" />);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById("concentration")).toHaveClass("glossary-row--highlight");
    // A non-matching row is never highlighted.
    expect(document.getElementById("hf")).not.toHaveClass("glossary-row--highlight");
  });
});
