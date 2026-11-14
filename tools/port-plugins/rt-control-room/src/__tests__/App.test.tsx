import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";

describe("App", () => {
  it("waits for Port when no bridge data has arrived", () => {
    render(<App />);
    expect(screen.getByText("Waiting for Port...")).toBeTruthy();
  });
});
