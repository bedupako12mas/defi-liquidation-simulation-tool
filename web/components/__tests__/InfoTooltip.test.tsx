import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InfoTooltip } from "../shared/InfoTooltip";
import { NavigationProvider, useNavigation } from "@/lib/hooks/useNavigation";

/** Renders the active tab/anchor as text so a test can assert on goTo's real effect instead
 *  of reaching into the provider's internals. */
function NavigationProbe() {
  const { active, pendingAnchor } = useNavigation();
  return <div data-testid="nav-probe">{active}:{pendingAnchor ?? "none"}</div>;
}

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

  it("without glossaryId, renders no glossary link", () => {
    render(<InfoTooltip label="What this means">The precise technical definition.</InfoTooltip>);
    fireEvent.click(screen.getByRole("button", { name: "What this means" }));
    expect(screen.queryByText(/Full definition/)).toBeNull();
  });

  it("with glossaryId, the popover's link jumps to that Glossary row and closes the popover", () => {
    render(
      <NavigationProvider>
        <NavigationProbe />
        <InfoTooltip label="What this means" glossaryId="hf">
          The precise technical definition.
        </InfoTooltip>
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "What this means" }));
    expect(screen.getByTestId("nav-probe")).toHaveTextContent("overview:none");

    fireEvent.click(screen.getByText(/Full definition & formula/));
    expect(screen.getByTestId("nav-probe")).toHaveTextContent("glossary:hf");
    // The popover closes once it navigates away, rather than staying open on a tab it no
    // longer makes sense on.
    expect(screen.queryByText("The precise technical definition.")).toBeNull();
  });
});
