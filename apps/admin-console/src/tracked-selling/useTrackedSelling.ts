/**
 * RT-455 part 1 hooks: one TanStack Query read of the tenant's tracked-selling
 * switch, shared by the shell's navigation, the tracking pages and the tenant
 * page, and the switch command.
 *
 * The read travels as a result (`TrackedSellingRead`), never a thrown error, so
 * a caller branches on data. A request that threw before any status is a failed
 * read (status 0). After a saved switch the answer replaces the cached read, so
 * the navigation in this tab follows at once (another tab or session sees the
 * change on its next read); after a refusal the read is fetched again so
 * the screen shows the server's current state.
 */
import {
  type SetTrackedSellingCommand,
  getTrackedSellingSetting,
  setTrackedSellingSetting,
} from "@/lib/tracked-selling-queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type SwitchOutcome,
  type TrackedSellingRead,
  canReadTrackedSelling,
  classifyRead,
  classifyWrite,
} from "./trackedSellingLogic";

const trackedSellingKeys = {
  // The role is in the key: an owner's full read and a store_manager's on/off
  // read are different answers and never stand in for each other.
  setting: (tenantId: string | null, role: string | null | undefined) =>
    ["tracked-selling", tenantId, role ?? null] as const,
};

async function readSetting(): Promise<TrackedSellingRead> {
  try {
    return classifyRead(await getTrackedSellingSetting());
  } catch {
    return { kind: "error", status: 0 };
  }
}

/**
 * The switch for the active tenant. Not asked for a role the contract refuses,
 * nor without a tenant: `data` stays undefined, which hides tracking.
 */
export function useTrackedSellingQuery(
  tenantId: string | null,
  role: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: trackedSellingKeys.setting(tenantId, role),
    enabled: enabled && Boolean(tenantId) && canReadTrackedSelling(role),
    queryFn: readSetting,
    retry: false,
    staleTime: 60_000,
  });
}

export interface TrackedSellingSwitch {
  submit: (command: SetTrackedSellingCommand) => Promise<SwitchOutcome>;
  pending: boolean;
}

export function useTrackedSellingSwitch(tenantId: string, role: string): TrackedSellingSwitch {
  const queryClient = useQueryClient();
  const key = trackedSellingKeys.setting(tenantId, role);
  const mutation = useMutation({
    mutationFn: async (command: SetTrackedSellingCommand): Promise<SwitchOutcome> => {
      try {
        return classifyWrite(await setTrackedSellingSetting(command));
      } catch {
        return { kind: "failed" };
      }
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "saved") {
        const read: TrackedSellingRead = { kind: "ok", setting: outcome.setting };
        queryClient.setQueryData(key, read);
        return;
      }
      // Re-read what the server holds now: the unmet list, a gate that went
      // off, or a switch whose answer was lost.
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  return { submit: mutation.mutateAsync, pending: mutation.isPending };
}
