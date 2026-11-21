/**
 * Hands a `Blob` to the browser as a file: an object URL behind a temporary `<a download>`. No
 * request is made and nothing leaves the page, so it needs nothing from the CSP's `connect-src
 * 'self'`. Shared by the CSV downloads (RT-824) and the import's server files (RT-1509).
 */

/** How long the object URL lives: long enough for the browser to start the save. */
const REVOKE_AFTER_MS = 1000;

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
