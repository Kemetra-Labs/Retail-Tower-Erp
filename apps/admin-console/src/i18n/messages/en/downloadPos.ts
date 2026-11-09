import type { downloadPos as ar } from "../ar/downloadPos";
import type { MessagesOf } from "../types";

export const downloadPos: MessagesOf<typeof ar> = {
  "devices.download.title": "Download POS",
  "devices.download.badge": "Pilot",
  "devices.download.sub":
    "A pilot installer for the POS, available only to organizations in the pilot.",
  "devices.download.multiTenant":
    "If you work with more than one tenant, choose the pilot tenant first.",

  "devices.download.panel.download": "Download",
  "devices.download.field.product": "Product",
  "devices.download.field.platform": "Platform",
  "devices.download.field.version": "Version",
  "devices.download.field.fileName": "File name",
  "devices.download.field.size": "Size",
  "devices.download.field.sha256": "SHA-256",
  "devices.download.field.publisher": "Expected publisher",
  "devices.download.action": "Download POS",
  "devices.download.actionHelp": "Each click creates a new link that works for a few minutes.",
  "devices.download.busy": "Preparing the link…",
  "devices.download.copy": "Copy SHA-256",
  "devices.download.copied": "Copied",
  "devices.download.copyManual": "The value is selected. Copy it manually.",

  "devices.download.issued":
    "The download link is ready. Your browser usually starts the download within moments. If it doesn't start or the link expired, select Download POS again to get a new link.",
  "devices.download.unavailable":
    "No POS download is available for your organization right now. If your organization is in the pilot, contact Kemetra support.",
  "devices.download.notAllowed": "Download POS is not available to you.",
  "devices.download.failed":
    "The download link could not be prepared. No link was created. Try again. If it repeats, send the request ID to support.",
  "devices.download.notStarted":
    "The download could not be started. Select Download POS again to get a new link. If it repeats, contact support.",
  "devices.download.network":
    "The server could not be reached. Check your connection, then try again.",
  "devices.download.retry": "Get a new link",

  "devices.download.panel.before": "Before you install",
  "devices.download.before.signed":
    "This installer is signed with a private pilot certificate, not a publicly trusted one.",
  "devices.download.before.trust":
    "Windows trusts it only on a device where the certificate was admitted. Admitting a device is a separate step that Kemetra approves; downloading does not grant it.",
  "devices.download.before.warning":
    "Windows may show a warning. This version does not update itself.",

  "devices.download.panel.verify": "Verify the file",
  "devices.download.verify.step":
    "When the download finishes, open PowerShell in the download folder and run the command below, then compare the result with the SHA-256 shown above.",
  "devices.download.verify.mismatch":
    "If it differs, don't run the file. Delete it and contact support.",

  "devices.download.panel.install": "Install and pair",
  "devices.download.install.step":
    "Install it only on a device where the certificate was admitted, following the device provisioning runbook, then pair the device from {pairing}.",
  "devices.download.support": "For help with the download or install, contact Kemetra support.",
};
