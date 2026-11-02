/**
 * RT-1071: the typed wrapper over `consoleGetSystemStatus` (RT-1056 D-1..D-5,
 * runtime RT-1062). One GET through the generated client; nothing else is
 * called, and nothing reaches ERPNext. Same `{ status, data, error }` shape as
 * the other wrappers.
 */
import { apiClient } from "@/generated/client";
import type { ConsoleSystemStatusSchema } from "@/generated/schema";

type Schemas = ConsoleSystemStatusSchema.components["schemas"];

export type ConsoleSystemStatus = Schemas["ConsoleSystemStatus"];
export type ComponentState = Schemas["ComponentState"];
export type ComponentLink = Schemas["ComponentLink"];

/** GET /api/v1/system-status. */
export async function consoleGetSystemStatus() {
  const { data, error, response } = await apiClient.GET("/api/v1/system-status", {});
  return { status: response.status, data, error };
}
