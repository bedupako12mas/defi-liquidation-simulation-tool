import type { UcFrontierRow } from "@/lib/api/meta";

/**
 * docs/SCOPE.md §4.3's "worked comparison" table - the thesis compressed into one inequality:
 * LTV_UC = 1/(1+i). Low incentive -> high frontier -> real headroom for high LTV. Same
 * component as v1's ThresholdTable (app/web/components/ThresholdTable.tsx), renamed to match
 * FRONTEND_STRATEGY.md's v2 folder listing - behavior unchanged.
 */
export function UcFrontierTable({ rows }: { rows: UcFrontierRow[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Protocol</th>
            <th>Asset</th>
            <th>Incentive (i)</th>
            <th>UC frontier 1/(1+i)</th>
            <th>Liquidation threshold</th>
            <th>Headroom</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const headroom = row.ucFrontierPct - row.liquidationThresholdPct;
            const [tag, ...noteParts] = row.provenance.split(":");
            return (
              <tr key={`${row.protocol}-${row.asset}`}>
                <td style={{ textTransform: "capitalize" }}>{row.protocol}</td>
                <td>{row.asset}</td>
                <td className="num">{row.incentivePct.toFixed(2)}%</td>
                <td className="num">{row.ucFrontierPct.toFixed(2)}%</td>
                <td className="num">{row.liquidationThresholdPct.toFixed(2)}%</td>
                <td className="num">{headroom.toFixed(2)} pts</td>
                <td className="provenance">
                  <span className={`tag ${tag === "cited" ? "tag-cited" : "tag-illustrative"}`}>{tag}</span>
                  <div>{noteParts.join(":").trim()}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
