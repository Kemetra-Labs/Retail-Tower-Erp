import { AuditInspectDrawer } from "@/audit/AuditInspectDrawer";
import { AuditTable } from "@/audit/AuditTable";
import { auditActionLabelKey } from "@/audit/auditActionLabel";
import type { AuditRow } from "@/audit/useAuditSearch";
import { setLocale } from "@/i18n/locale";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

/**
 * RT-784 (RT-777 S5): platform support-session rows in the tenant's own audit
 * view. Action codes and metadata come from the pinned `audit.openapi.yaml`
 * (`AuditEvent`) and `platform-support-sessions.openapi.yaml`
 * (`SupportSessionAuditMetadata`, `CrossTenantAccessAuditMetadata`). Each row
 * keeps its verbatim, LTR-isolated action code; a known code also gets a
 * recognisable label. An unknown code renders the code alone.
 */

const SESSION = "01a16955-845f-7559-99ae-7197bef2b47e";

function platformRow(action: string, metadata: Record<string, unknown>): AuditRow {
  return {
    id: `row-${action}-${String(metadata.outcome ?? "")}`,
    occurred_at: "2026-10-23T15:16:14Z",
    action,
    actor_user_id: "b74f1728-0000-4000-8000-000000000001",
    actor_label: "platform_support",
    store_id: null,
    target_type: null,
    target_id: null,
    request_id: "22222222-2222-4222-8222-222222222222",
    metadata,
  };
}

const opened = platformRow("platform.support_session.opened", {
  actor_kind: "platform_admin",
  outcome: "succeeded",
  support_session_id: SESSION,
  purpose: "customer_support",
  ticket_ref: "RT-782",
  expires_at: "2026-10-23T16:16:14Z",
});
const renewed = platformRow("platform.support_session.renewed", {
  actor_kind: "platform_admin",
  outcome: "succeeded",
  support_session_id: SESSION,
  purpose: "customer_support",
  ticket_ref: null,
  expires_at: "2026-10-23T17:16:14Z",
});
const ended = platformRow("platform.support_session.ended", {
  actor_kind: "platform_admin",
  outcome: "succeeded",
  support_session_id: SESSION,
  purpose: "customer_support",
  ticket_ref: "RT-782",
  end_reason: "operator",
});
const accessed = platformRow("platform.cross_tenant.accessed", {
  actor_kind: "platform_admin",
  outcome: "succeeded",
  support_session_id: SESSION,
  purpose: "customer_support",
  method: "GET",
  route: "/api/v1/sales/:saleId",
});
const refused = platformRow("platform.cross_tenant.accessed", {
  actor_kind: "platform_admin",
  outcome: "rejected",
  reason: "support_session_read_only",
  support_session_id: SESSION,
  purpose: "customer_support",
  method: "POST",
  route: "/api/v1/stores",
});

const CASES: { row: AuditRow; en: string; ar: string }[] = [
  { row: opened, en: "Support session opened", ar: "فُتحت جلسة دعم" },
  { row: renewed, en: "Support session renewed", ar: "جُدّدت جلسة دعم" },
  { row: ended, en: "Support session ended", ar: "انتهت جلسة دعم" },
  { row: accessed, en: "Platform support access", ar: "وصول دعم المنصة" },
  { row: refused, en: "Platform support access refused", ar: "رُفض وصول دعم المنصة" },
];

describe("RT-784 audit labels for platform support-session rows", () => {
  for (const { row, en } of CASES) {
    const name = `${row.action} (${String(row.metadata?.outcome)})`;

    test(`table: ${name} shows "${en}" and keeps the code verbatim, LTR`, () => {
      render(<AuditTable rows={[row]} onInspect={vi.fn()} />);
      const button = screen.getByRole("button");
      expect(within(button).getByText(en)).toBeDefined();
      const code = within(button).getByText(row.action);
      expect(code.tagName).toBe("BDI");
      expect(code.getAttribute("dir")).toBe("ltr");
      // The accessible name carries both, so the row is recognisable to AT.
      expect(button.textContent).toContain(en);
      expect(button.textContent).toContain(row.action);
    });

    test(`inspect: ${name} shows "${en}" beside the verbatim code`, () => {
      render(<AuditInspectDrawer row={row} onClose={vi.fn()} />);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(en)).toBeDefined();
      expect(within(dialog).getByText(row.action).getAttribute("dir")).toBe("ltr");
    });
  }

  test("Arabic: every label renders in Arabic in the table and the drawer; codes unchanged", () => {
    setLocale("ar");
    for (const { row, ar, en } of CASES) {
      const table = render(<AuditTable rows={[row]} onInspect={vi.fn()} />);
      expect(within(table.container).getByText(ar)).toBeDefined();
      expect(within(table.container).queryByText(en)).toBeNull();
      expect(within(table.container).getByText(row.action)).toBeDefined();
      table.unmount();

      const drawer = render(<AuditInspectDrawer row={row} onClose={vi.fn()} />);
      const dialog = within(drawer.baseElement).getByRole("dialog");
      expect(within(dialog).getByText(ar)).toBeDefined();
      expect(within(dialog).getByText(row.action)).toBeDefined();
      drawer.unmount();
    }
  });

  test("an unknown future platform action renders its code alone, without a label or a crash", () => {
    const future = platformRow("platform.support_session.suspended", { outcome: "succeeded" });
    render(<AuditTable rows={[future]} onInspect={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("platform.support_session.suspended");
    expect(auditActionLabelKey(future)).toBeUndefined();
  });

  test("an unknown action still opens in the drawer with its code", () => {
    const future = platformRow("platform.break_glass.started", {});
    render(<AuditInspectDrawer row={future} onClose={vi.fn()} />);
    expect(screen.getByText("platform.break_glass.started")).toBeDefined();
    for (const { en } of CASES) expect(screen.queryByText(en)).toBeNull();
  });

  test("an unrecognised cross-tenant outcome, or no metadata, falls back to the neutral access label", () => {
    const odd = platformRow("platform.cross_tenant.accessed", { outcome: "partial" });
    expect(auditActionLabelKey(odd)).toBe("audit.action.crossTenantAccessed");
    const bare: AuditRow = { ...accessed, metadata: undefined };
    expect(auditActionLabelKey(bare)).toBe("audit.action.crossTenantAccessed");
    const nullMeta = { ...accessed, metadata: null } as unknown as AuditRow;
    expect(auditActionLabelKey(nullMeta)).toBe("audit.action.crossTenantAccessed");
    render(<AuditTable rows={[bare, nullMeta]} onInspect={vi.fn()} />);
    expect(screen.getAllByText("Platform support access")).toHaveLength(2);
  });

  test("codes that only look like object keys get no label (no prototype lookup)", () => {
    for (const action of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect(auditActionLabelKey(platformRow(action, {}))).toBeUndefined();
    }
  });

  test("a non-string action from a malformed row gets no label and does not throw", () => {
    const malformed = { ...opened, action: 42 } as unknown as AuditRow;
    expect(auditActionLabelKey(malformed)).toBeUndefined();
  });

  test("non-platform rows are unchanged: no label, code only", () => {
    const shift: AuditRow = {
      id: "e1",
      occurred_at: "2026-06-01T09:30:00Z",
      action: "shift.forced_close",
      actor_label: "Omar Khaled",
    };
    render(<AuditTable rows={[shift]} onInspect={vi.fn()} />);
    expect(screen.getByRole("button").textContent).toBe("shift.forced_close");
  });

  test("the actor label and metadata are untrusted text: rendered as text, never as markup", () => {
    const hostile = platformRow("platform.support_session.opened", {
      purpose: "<img src=x onerror=alert(1)>",
    });
    const withLabel = { ...hostile, actor_label: "<b>platform_support</b>" };
    const { container } = render(<AuditInspectDrawer row={withLabel} onClose={vi.fn()} />);
    expect(container.ownerDocument.querySelector("img")).toBeNull();
    expect(container.ownerDocument.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>platform_support</b>")).toBeDefined();
  });
});
