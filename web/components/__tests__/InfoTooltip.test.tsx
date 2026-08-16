import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InfoTooltip } from "../shared/InfoTooltip";

describe("InfoTooltip", () => {
  it("hides the technical content until the trigger is opened, then toggles it closed again", () => {
    render(<InfoTooltip label="What this means">The precise technical definition.</InfoTooltip>);

    const trigger = screen.getByRole("button", { name: "What this means" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The precise technical definition.")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The precise technical definition.")).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The precise technical definition.")).toBeNull();
  });

  it("closes when Escape is pressed or a click lands outside it", () => {
    render(
      <div>
        <InfoTooltip label="What this means">The precise technical definition.</InfoTooltip>
        <button type="button">Outside</button>
      </div>
    );

    const trigger = screen.getByRole("button", { name: "What this means" });
    fireEvent.click(trigger);
    expect(screen.getByText("The precise technical definition.")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("The precise technical definition.")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("The precise technical definition.")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByText("The precise technical definition.")).toBeNull();
  });
});
