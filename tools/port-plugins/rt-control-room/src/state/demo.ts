/**
 * True only when the plugin's own URL carries `demo=1`. Only `window.location.search`
 * is read (never the referrer or anything Port forwards), so a normal Port tile has
 * no example button and the board shows nothing but real data.
 */
export function isDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}
