/**
 * RT-1338: the page shown when no tenant is in scope yet. One muted sentence naming what to choose a
 * tenant for; nothing is requested until a tenant is chosen.
 */
export function ScopePrompt({ message }: Readonly<{ message: string }>): React.JSX.Element {
  return (
    <div className="surface">
      <p className="content__sub">{message}</p>
    </div>
  );
}
