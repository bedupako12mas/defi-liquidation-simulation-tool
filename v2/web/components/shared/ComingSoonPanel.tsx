/**
 * The Milestone-2 placeholder. Rendered by CascadeDetailTab and ValidationTab while
 * `capabilities.fork` is false (see lib/hooks/useCapabilities.ts). Deliberately says what is
 * NOT built yet, rather than implying partial functionality - see
 * docs/FRONTEND_STRATEGY.md's milestone table.
 */

export function ComingSoonPanel({
  title,
  description,
  reservedComponents,
}: {
  title: string;
  description: string;
  reservedComponents?: string[];
}) {
  return (
    <div className="coming-soon">
      <h3>{title}</h3>
      <p>{description}</p>
      <p className="preset-note" style={{ margin: "0.75rem auto 0" }}>
        Gated on <code>capabilities.fork</code> from <code>/api/meta</code>, currently{" "}
        <code>false</code>. Lights up automatically once the mainnet-fork tier ships
        server-side - no frontend deploy required.
      </p>
      {reservedComponents && reservedComponents.length > 0 && (
        <div className="reserved-list">
          <p style={{ marginBottom: "0.4rem", color: "var(--text-secondary)" }}>
            Reserved for Milestone 2 (names exist, not yet implemented):
          </p>
          <ul className="limitations">
            {reservedComponents.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
