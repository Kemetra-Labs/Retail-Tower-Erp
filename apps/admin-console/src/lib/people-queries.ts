/**
 * RT-1070 data layer: one typed wrapper over the generated `apiClient` for the
 * Backend-Core people-name read (RT-968 option A, `listPeopleNames`):
 *
 *   - `consoleListPeopleNames`: display names for up to 200 user ids of the
 *     session tenant. Unknown and unresolvable ids are absent from the answer.
 *
 * Boundary: this ONE operation only. Same `{ status, data?, error? }` shape as
 * `src/lib/shift-close-queries.ts`; cookie transport is on the generated client.
 */
import { apiClient } from "@/generated/client";
import type { ConsolePeopleSchema } from "@/generated/schema";

type Schemas = ConsolePeopleSchema.components["schemas"];

export type PersonName = Schemas["PersonName"];
export type PeopleNames = Schemas["PeopleNames"];

/** GET /api/v1/console/people?ids=a,b,c (1 to 200 ids, comma-separated). */
export async function consoleListPeopleNames(ids: readonly string[]) {
  const { data, error, response } = await apiClient.GET("/api/v1/console/people", {
    params: { query: { ids: [...ids] } },
    // The contract is `style: form, explode: false`: `ids=a,b`. The client default
    // (`ids=a&ids=b`) is a 400 (a repeated `ids` key).
    querySerializer: { array: { style: "form", explode: false } },
  });
  return { status: response.status, data, error };
}
