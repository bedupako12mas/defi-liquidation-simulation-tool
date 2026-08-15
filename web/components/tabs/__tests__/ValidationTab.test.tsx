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

  it("renders real tables, not just prose", async () => {
    const { container } = render(<ValidationTab />);
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0));
    expect(container.querySelectorAll("table").length).toBe(2);
  });
});
