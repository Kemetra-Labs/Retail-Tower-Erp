import type { search as ar } from "../ar/search";
import type { MessagesOf } from "../types";

/** English copy for global search. */
export const search: MessagesOf<typeof ar> = {
  // --- Heading ---------------------------------------------------------------
  "search.title": "Search",
  "search.nav.label": "Search",
  "search.scopePrompt": "Select a tenant to search.",
  "search.subtitle":
    "Products by name or identifier, sales by receipt number, operators by name or email.",

  // --- Form ------------------------------------------------------------------
  "search.input.label": "Search",
  "search.input.placeholder": "Product name, barcode, receipt number, operator name…",
  "search.submit": "Search",

  // --- Before a term ----------------------------------------------------------
  "search.intro.title": "What you can search",
  "search.intro.products": "Products — by name, or by an exact barcode, SKU or PLU.",
  "search.intro.sales": "Sales — by the exact receipt number, in the active store's last 31 days.",
  "search.intro.operators": "Operators — by name or email, across the tenant's members.",

  // --- Products ---------------------------------------------------------------
  "search.products.title": "Products",
  "search.products.hint": "An exact barcode, SKU or PLU, or a part of the product name. Active products only.",
  "search.products.empty": "No products match “{q}”.",
  "search.products.more": "Showing the first {count}.",
  "search.products.seeAll": "See all matches in the catalog",
  "search.products.col.name": "Product",
  "search.products.col.status": "Status",

  // --- Sales -------------------------------------------------------------------
  "search.sales.title": "Sales",
  "search.sales.hint": "An exact receipt number, in the active store's last 31 days.",
  "search.sales.needsStore": "Pick a store in the scope header to look up a receipt number.",
  "search.sales.tooLong": "A receipt number is at most 96 characters.",
  "search.sales.empty": "No sale with receipt number “{q}” in the last 31 days.",
  "search.sales.col.number": "Receipt",
  "search.sales.col.date": "Business day",
  "search.sales.col.total": "Total",

  // --- Operators ---------------------------------------------------------------
  "search.operators.title": "Operators",
  "search.operators.hint": "By name or email, across the tenant's members.",
  "search.operators.empty": "No operators match “{q}”.",
  "search.operators.col.name": "Name",
  "search.operators.col.email": "Email",
  "search.operators.col.role": "Role",

  // --- States -------------------------------------------------------------------
  "search.nothing": "Nothing here can be searched for your role.",
  "search.loading": "Searching…",
  "search.failed": "The search could not be loaded.",
  "search.retry": "Retry",
};
