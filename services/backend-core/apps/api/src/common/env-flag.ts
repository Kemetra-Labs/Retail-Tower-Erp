/** A deployment flag: "1", "true" or "yes", case-insensitive, trimmed; anything else is off. */
export function isEnvFlagOn(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
