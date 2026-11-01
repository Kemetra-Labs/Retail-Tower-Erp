import type { branding as ar } from "../ar/branding";
import type { MessagesOf } from "../types";

export const branding: MessagesOf<typeof ar> = {
  // --- Page and entry ---------------------------------------------------------
  "branding.title": "Tenant branding",
  "branding.back": "Back to the tenant",
  "branding.loadingNoun": "tenant logo",
  "branding.loadFailed": "The tenant logo could not be loaded.",
  "branding.sessionExpired": "Your session has ended. Sign in again.",
  "branding.retry": "Try again",

  // --- Current logo (section 1) -----------------------------------------------
  "branding.current.title": "Current logo",
  "branding.current.empty":
    "The tenant has no logo. Cashier terminals show the tenant name as text in its place.",
  "branding.current.updatedAt": "Last updated",
  "branding.current.alt": "The tenant's current logo",
  "branding.replace": "Replace logo",
  "branding.remove": "Remove logo",
  "branding.remove.confirm":
    "Remove the tenant logo? Cashier terminals and receipts will show the tenant name as text instead.",

  // --- Upload field (section 2) -----------------------------------------------
  "branding.upload.titleEmpty": "Upload a logo",
  "branding.upload.titleNew": "New logo",
  "branding.upload.label": "Logo file",
  "branding.upload.choose": "Upload a logo",
  "branding.upload.chooseAnother": "Choose another file",
  "branding.upload.requirements":
    "PNG or SVG, up to 1 MB. At least 512×512 pixels for a square logo, or 256 pixels tall for a wide logo.",
  "branding.upload.fileSize": "{size} KB",

  // --- Refusals ---------------------------------------------------------------
  "branding.refusal.file_type_not_allowed":
    "This file type is not supported. Upload a PNG or SVG image.",
  "branding.refusal.image_malformed":
    "The image could not be read; the file may be damaged. Save the logo again in your design tool, then upload it.",
  "branding.refusal.image_dimensions_too_large":
    "The image is too large. The maximum is 4000 pixels per side.",
  "branding.refusal.image_too_small":
    "The image is too small. It needs at least 512×512 pixels for a square logo, or 256 pixels tall for a wide logo.",
  "branding.refusal.aspect_ratio_out_of_range":
    "The logo's shape does not fit. Its width to height ratio must be between 1:1 and 4:1.",
  "branding.refusal.image_empty": "The image has no visible logo.",
  "branding.refusal.svg_unsafe_content":
    "This SVG file contains elements that are not allowed for security reasons. Export the logo as a PNG and upload that.",
  "branding.refusal.svg_unsupported":
    "This SVG file could not be processed. Export the logo as a PNG and upload that.",
  "branding.refusal.file_too_large": "The file is larger than 1 MB.",
  "branding.refusal.logo_preview_mismatch":
    "The file does not match the preview shown. Choose the file again to see a new preview, then save.",
  "branding.refusal.unknown": "This file could not be accepted as a logo.",
  "branding.refusal.unchanged": "The current logo has not changed.",

  // --- Warnings ---------------------------------------------------------------
  "branding.warning.low_contrast":
    "The logo is light on a white background, so cashier terminals will show it on a white card with a border. You can save it as it is.",
  "branding.warning.receipt_high_black_coverage":
    "The receipt version has a lot of black, so the logo may print as a dark block and printing gets slower. A logo on a light background gives a clearer result.",
  "branding.warning.receipt_thin_strokes":
    "Some of the logo's lines are very thin and may disappear in thermal printing. A logo with bolder lines gives a clearer result.",

  // --- Previews ---------------------------------------------------------------
  "branding.screen.title": "As it will appear on cashier terminals",
  "branding.slot.boot": "Start-up screen",
  "branding.slot.pairing": "Device pairing screen",
  "branding.slot.sign_in": "Sign-in bar",
  "branding.slot.lock": "Lock screen",
  "branding.poweredBy": "Powered by {name}",
  "branding.receipt.title": "As it will print on the receipt",
  "branding.receipt.alt": "The receipt version of the logo",
  "branding.receipt.size": "Printed size: {width} × {height} mm",
  "branding.receipt.approx": "Approximate size on screen",
  "branding.preview.loading": "Preparing the preview",
  "branding.preview.retry": "Show the preview again",

  // --- Actions and outcomes ---------------------------------------------------
  "branding.save": "Save logo",
  "branding.saved": "Logo saved. Cashier terminals will show it after their data refreshes.",
  "branding.removed":
    "Logo removed. Cashier terminals will show the tenant name as text after their data refreshes.",
  "branding.conflict":
    "The tenant logo changed after you opened this page. Refresh the page to see the current logo, then try again.",
  "branding.conflict.reload": "Refresh the page",
};
