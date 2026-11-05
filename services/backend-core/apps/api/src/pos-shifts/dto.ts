import { z } from "zod";
import { UUID_RE_I } from "../common/ids";


export const StuckShiftsQuerySchema = z.object({
  branch_id: z
    .string({ required_error: "branch_id is required" })
    .regex(UUID_RE_I, "branch_id must be a valid UUID"),
});

export type StuckShiftsQuery = z.infer<typeof StuckShiftsQuerySchema>;

export interface StuckShiftItem {
  shift_id: string;
  cashier_display_name: string;
  terminal_label: string;
  opened_at: string;
  duration_minutes: number;
}

export interface StuckShiftsResponseBody {
  kind: "ok";
  shifts: StuckShiftItem[];
}
