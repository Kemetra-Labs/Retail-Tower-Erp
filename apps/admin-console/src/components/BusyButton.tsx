/**
 * RT-959: the one busy pattern. While `busy`, the button is aria-busy and
 * aria-disabled but never natively disabled, so keyboard focus stays on it; a
 * guard drops every activation (a click, and Enter submitting its form, which
 * arrives as a click on the default button) and the shared spinner sits before
 * the caller's label. The label itself still says what is happening
 * ("Saving…"): screen readers rarely announce aria-busy on a button.
 *
 * `disabled` stays for a genuinely unavailable action (the styles recess it);
 * busy keeps the variant's colours (controls.css).
 */
export type BusyButtonProps = React.ComponentPropsWithRef<"button"> & {
  type?: "button" | "submit";
  busy?: boolean;
};

export function BusyButton({
  type = "button",
  busy = false,
  onClick,
  children,
  ...rest
}: Readonly<BusyButtonProps>): React.JSX.Element {
  const guard = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      type={type}
      onClick={guard}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest["aria-disabled"] || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
