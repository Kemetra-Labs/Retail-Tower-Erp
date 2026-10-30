import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test } from "vitest";

import { FormField } from "@/components/FormField";
import { FormAside, FormPage, FormPanel, FormSection } from "@/components/FormPage";
import { readSource } from "./source-scan";

/**
 * RT-971 (canvas «نموذج», DESIGN.md §9 "Form template"): the shared form-page
 * template, and AC 1: every listed form uses it and none keeps the bespoke
 * form classes it replaced.
 */

afterEach(cleanup);

function page(): void {
  render(
    <MemoryRouter>
      <FormPage
        back={{ to: "/stores", label: "Back to stores" }}
        title="Add store"
        subtitle="The store will be created in Northstar Retail."
        notices={<p>notice</p>}
        aside={
          <FormAside title="After you create it">
            <ol>
              <li>Map the warehouse.</li>
            </ol>
          </FormAside>
        }
      >
        <FormPanel
          aria-label="Store"
          summary={<div data-testid="summary">summary</div>}
          actions={
            <>
              <button type="submit" className="btn-primary">
                Create store
              </button>
              <button type="button" className="btn-ghost">
                Cancel
              </button>
            </>
          }
        >
          <FormSection title="Store details" columns={2}>
            <FormField id="store-name" label="Store name" required hint="Shown to users.">
              {(aria) => <input id="store-name" className="input" {...aria} />}
            </FormField>
            <FormField id="store-code" label="Store code" error="That code is in use.">
              {(aria) => <input id="store-code" className="input" {...aria} />}
            </FormField>
          </FormSection>
          <FormSection title="Timing" disabled>
            <FormField id="store-timezone" label="Time zone">
              {(aria) => <select id="store-timezone" className="input" {...aria} />}
            </FormField>
          </FormSection>
        </FormPanel>
      </FormPage>
    </MemoryRouter>,
  );
}

describe("form page template", () => {
  test("back link above the page's one h1, then the notices, the panel and the aside", () => {
    page();
    const back = screen.getByRole("link", { name: /Back to stores/ });
    expect(back.getAttribute("href")).toBe("/stores");
    const h1 = screen.getByRole("heading", { level: 1, name: "Add store" });
    // The back link comes before the header in document order.
    expect(back.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("The store will be created in Northstar Retail.")).toBeDefined();
    const body = document.querySelector(".form-page__body") as HTMLElement;
    expect(Array.from(body.children).map((c) => c.tagName)).toEqual(["FORM", "ASIDE"]);
    expect(screen.getByRole("complementary", { name: "After you create it" })).toBeDefined();
  });

  test("the panel is a real form: summary first, sections as fieldsets, actions at the foot", () => {
    page();
    const form = screen.getByRole("form", { name: "Store" });
    expect(form.className).toBe("form-panel form-panel--panel");
    expect(form.hasAttribute("novalidate")).toBe(true);
    const kids = Array.from(form.children).map((c) => c.className);
    expect(kids[0]).toBe("form-panel__summary");
    expect(kids.at(-1)).toBe("form-panel__actions");
    const details = screen.getByRole("group", { name: "Store details" });
    expect(details.tagName).toBe("FIELDSET");
    expect(details.querySelector(".form-section__fields--2")).not.toBeNull();
    // Primary first, then Cancel as ghost (RT-957).
    const actions = form.querySelector(".form-panel__actions") as HTMLElement;
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.className),
    ).toEqual(["btn-primary", "btn-ghost"]);
  });

  test("a disabled section locks its controls", () => {
    page();
    const timing = screen.getByRole("group", { name: "Timing" }) as HTMLFieldSetElement;
    expect(timing.disabled).toBe(true);
  });

  test("a field: label above, the required mark outside the label text, hint and error describe the control", () => {
    page();
    const name = screen.getByLabelText("Store name");
    expect(name.getAttribute("aria-required")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("store-name-hint");
    // The mark is CSS on the field, never text in the label or its name.
    expect(name.closest(".field")?.className).toBe("field field--required");
    expect(screen.getByText("Store name").textContent).toBe("Store name");
    const code = screen.getByLabelText("Store code");
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(code.getAttribute("aria-describedby")).toBe("store-code-error");
    const error = document.getElementById("store-code-error") as HTMLElement;
    expect(error.textContent).toBe("That code is in use.");
    // On a page form the summary announces; the inline error is not a second live region.
    expect(error.getAttribute("role")).toBeNull();
  });

  test("a form with no summary announces its own field error", () => {
    render(
      <FormPanel variant="plain" aria-label="Invite" actions={<button type="submit">Send</button>}>
        <FormSection>
          <FormField id="invite-email" label="Email" error="Enter an email." announceError>
            {(aria) => <input id="invite-email" {...aria} />}
          </FormField>
        </FormSection>
      </FormPanel>,
    );
    expect(screen.getByRole("form", { name: "Invite" }).className).toBe(
      "form-panel form-panel--plain",
    );
    expect(screen.getByRole("alert").textContent).toBe("Enter an email.");
  });
});

/** AC 1: the listed forms are on the template; the classes it replaced are gone from them. */
const TEMPLATE_FORMS: Record<string, readonly string[]> = {
  "src/stores/StoreForm.tsx": [
    "FormPage",
    "FormPanel",
    "FormSection",
    "FormField",
    "FormErrorSummary",
  ],
  "src/tenants/TenantForm.tsx": [
    "FormPage",
    "FormPanel",
    "FormSection",
    "FormField",
    "FormErrorSummary",
  ],
  "src/catalog/ProductEditForm.tsx": ["FormPage", "FormPanel", "FormSection", "FormErrorSummary"],
  "src/operators/InviteMember.tsx": ["FormPanel", "FormSection", "FormField"],
  "src/operators/EditMember.tsx": ["FormPanel", "FormSection", "FormField"],
  "src/payers/PayerCreate.tsx": ["FormPanel", "FormSection", "FormField"],
  "src/erp-mappings/WarehouseMappings.tsx": ["FormPanel", "FormSection", "FormField"],
  "src/erp-mappings/SuggestMapping.tsx": ["FormPanel", "FormSection", "FormField"],
};

const RETIRED = [
  /className="surface__form"/,
  /surface__form-grid/,
  /surface__actions/,
  /surface__section-title/,
  /surface__scope-line/,
  /map-form__(grid|error)/,
  /catalog-form__fields/,
  /<form\b/,
];

describe("listed forms use the template (RT-971 AC 1)", () => {
  for (const [file, parts] of Object.entries(TEMPLATE_FORMS)) {
    test(file, () => {
      const src = readSource(file);
      for (const part of parts)
        expect(src, `${file} uses ${part}`).toMatch(new RegExp(`<${part}\\b`));
      for (const retired of RETIRED)
        expect(src, `${file} still has ${retired}`).not.toMatch(retired);
    });
  }
});
