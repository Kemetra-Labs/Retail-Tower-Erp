# RT-1022: POS renderer CSS and copy hygiene

Before and after captures at 1024×768, light and forced colours, of the surfaces whose CSS the slice touches. No behaviour changes. The voucher error copy differs in one punctuation mark (em dash to colon) and one digit («٣» to «3»); the capture injects the baseline text for `before` and the new text for `after`.

* **Baseline:** `8696ba18` (before) against this branch (after).
* **Tool:** [`tools/capture-rt1022.cjs`](tools/capture-rt1022.cjs) against `npx vite`. It writes [`rt1022-capture-log.json`](rt1022-capture-log.json) with the computed values below.
* **Void:** `#/dev/void-proof?state=Journal`, then the cancel dialog with the manager PIN field focused.
* **Manager home:** `#/dev/void-proof?state=RefServer&from=dashboard` (the router starts on the manager dashboard).
* **Voucher error:** the voucher tender is policy-hidden, so no harness reaches it. The capture mounts the production `<output class="voucher-error">` (and a bare `<input type="text">`, to take the global input rule) into the manager home, which loads the same stylesheet.

| Check | Before | After |
|---|---|---|
| Bare text input focus, `box-shadow` (light) | teal 3px ring | `none` |
| Bare text input focus, `outline` | 2px solid | 2px solid, offset 2px |
| Text input `transition-property` | `border-color, box-shadow` | `border-color` |
| Manager tile border (light) | `rgb(216, 223, 231)` hairline | `rgb(111, 123, 137)` (`--color-border-strong`) |
| Manager tile border (forced colours) | `CanvasText` | `CanvasText` (the forced rule is unchanged) |
| Void fact and row row-gap | 6px | 8px |
| Void state pill gap, inline padding | 6px, 10px | 8px, 12px |
| `.voucher-error` margin (t r b l) | 4px 2px 0 2px | 4px 0 0 0 |

The void PIN field already drew a 3px outline from its own v5 rule, so its ring did not change; the global input rule matters for inputs outside a v5 rule, which the bare input measures.

The `.v5-sales-field` gap (6px to 8px) is not captured: it is the same one-token move, covered by the `css-copy-hygiene` test.
