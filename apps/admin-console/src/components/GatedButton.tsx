/**
 * RT-621 (RT-574 D8): the repeat-submit gate. A button that disables itself and
 * shows a countdown while a Retry-After from Backend-Core is running, so a 429
 * cannot be hammered. Used on every write submit and every user-initiated read
 * control (filter apply, load more). Outside a window it is a plain button.
 *
 * The window is the shared clock (src/lib/rate-limit.ts): the console cannot
 * tell which server budget a 429 spent, so every gated control waits it out.
 */
import { BusyButton, type BusyButtonProps } from "@/components/BusyButton";
import { RateLimitCountdown } from "@/components/RateLimitBanner";
import { useRateLimit } from "@/lib/useRateLimit";

/**
 * RT-959: a BusyButton. `busy` is the shared pending pattern (focus kept);
 * a running Retry-After is a native disable, because the action is unavailable.
 */
export type GatedButtonProps = BusyButtonProps;

export function GatedButton({
  disabled,
  children,
  ...rest
}: Readonly<GatedButtonProps>): React.JSX.Element {
  const { active } = useRateLimit();
  return (
    <BusyButton {...rest} disabled={Boolean(disabled) || active}>
      {children}
      <RateLimitCountdown />
    </BusyButton>
  );
}
