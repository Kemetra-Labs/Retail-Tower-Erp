import { localeUserKey } from "@/i18n/locale";
import { themeUserKey } from "@/theme/theme";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test } from "vitest";

import { UserMenu } from "@/shell/UserMenu";

/**
 * RT-969: the top bar's user block. A disclosure holding the language (RT-399)
 * and theme (RT-398) switches; the user's stored choices are restored when the
 * shell mounts, not when the panel first opens.
 */

const user = { id: "u1", display_name: "Amal Saleh", email: "amal@northstar.eg" };
const button = () => screen.getByRole("button", { name: "Amal Saleh Tenant admin" });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("UserMenu", () => {
  test("is named by the name and role, collapsed, with its switches not shown", () => {
    render(<UserMenu user={user} roleLabel="Tenant admin" />, { wrapper: MemoryRouter });
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Dark mode" })).toBeNull();
  });

  test("opens the language and theme switches; Escape closes it back to its button", () => {
    render(<UserMenu user={user} roleLabel="Tenant admin" />, { wrapper: MemoryRouter });
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const group = screen.getByRole("group", { name: "Preferences" });
    const panel = document.getElementById(button().getAttribute("aria-controls") ?? "");
    expect(panel?.contains(group)).toBe(true);
    const theme = screen.getByRole("button", { name: "Dark mode" });
    expect(theme.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "التبديل إلى العربية" })).toBeDefined();
    theme.focus();
    fireEvent.keyDown(theme, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Preferences" })).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  test("a press outside closes it", () => {
    render(
      <>
        <UserMenu user={user} roleLabel="Tenant admin" />
        <p>outside</p>
      </>,
      { wrapper: MemoryRouter },
    );
    fireEvent.click(button());
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("group", { name: "Preferences" })).toBeNull();
  });

  test("the theme switch still persists per user (RT-398)", () => {
    render(<UserMenu user={user} roleLabel="Tenant admin" />, { wrapper: MemoryRouter });
    fireEvent.click(button());
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dark mode" }));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(themeUserKey("u1"))).toBe("dark");
  });

  test("restores the user's stored language and theme on mount, panel closed", () => {
    window.localStorage.setItem(localeUserKey("u1"), "ar");
    window.localStorage.setItem(themeUserKey("u1"), "dark");
    render(<UserMenu user={user} roleLabel="مسؤول المؤسسة" />, { wrapper: MemoryRouter });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.lang).toBe("ar-EG");
  });

  test("RT-807 (PW-1): links to «My account» under the preferences, and closes on follow", () => {
    render(<UserMenu user={user} roleLabel="Tenant admin" accountLink />, {
      wrapper: MemoryRouter,
    });
    fireEvent.click(button());
    const link = screen.getByRole("link", { name: "My account" });
    expect(link.getAttribute("href")).toBe("/account");
    fireEvent.click(link);
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  test("RT-807: no «My account» link unless the shell asks for it (platform shell, support session)", () => {
    render(<UserMenu user={user} roleLabel="Tenant admin" />, { wrapper: MemoryRouter });
    fireEvent.click(button());
    expect(screen.queryByRole("link", { name: "My account" })).toBeNull();
  });
});
