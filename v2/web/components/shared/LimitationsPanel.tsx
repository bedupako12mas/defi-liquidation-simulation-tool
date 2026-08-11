/**
 * Same component as v1's (app/web/components/LimitationsPanel.tsx), moved under
 * components/shared/ per FRONTEND_STRATEGY.md's v2 folder listing - it isn't overview-tab
 * specific (MethodologyTab renders it too, per the milestone table's "limitations table"
 * item), so it belongs alongside ComingSoonPanel rather than under components/overview/.
 */
export function LimitationsPanel({ limitations }: { limitations: string[] }) {
  return (
    <ul className="limitations">
      {limitations.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
