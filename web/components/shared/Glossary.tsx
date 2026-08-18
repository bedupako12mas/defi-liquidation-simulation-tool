/**
 * Every metric/status shown anywhere in this app, in one scannable reference - a
 * complement to the inline InfoTooltips scattered across Overview/Methodology/Validation
 * (those explain a term where it's used; this is the "I saw a word somewhere, what did it
 * mean" central lookup). Grouped by where each term actually appears, not alphabetically -
 * a reader arriving from a specific tab can find the relevant section directly.
 */

interface GlossaryEntry {
  term: string;
  plain: string;
  technical: string;
  shownIn: string;
}

interface GlossarySection {
  heading: string;
  entries: GlossaryEntry[];
}

const SECTIONS: GlossarySection[] = [
  {
    heading: "Position health & state",
    entries: [
      {
        term: "Health factor (HF)",
        plain: "A single number for how safe a position is. Above 1 is safe; below 1 means it can be liquidated.",
        technical: "Collateral value × liquidation threshold, divided by debt value. Empirically checked against Aave's own on-chain getUserAccountData() to within 10 bps on real positions.",
        shownIn: "Overview drilldown",
      },
      {
        term: "LTV (loan-to-value)",
        plain: "How much is currently borrowed, as a share of collateral value.",
        technical: "Current debt divided by current collateral value.",
        shownIn: "Overview drilldown",
      },
      {
        term: "Liquidation threshold",
        plain: "The LTV line past which a position becomes eligible for liquidation.",
        technical: "The protocol's own configured eligibility bar for a given asset - crossing it flips a position to Liquidatable/Eligible.",
        shownIn: "Overview drilldown, Methodology's UC frontier table",
      },
      {
        term: "UC frontier (undercollateralization frontier)",
        plain: "A second, much higher line - past it, liquidating a position can no longer make it healthier, only less bad.",
        technical: "LTVᵤ_C = 1/(1+i) for liquidation incentive i - a direct algebraic consequence of a fixed proportional liquidation bonus. Crossing it flips a position to Toxic.",
        shownIn: "Overview drilldown, Methodology",
      },
      {
        term: "Healthy / Liquidatable / Eligible / Toxic",
        plain: "The three states every position is in at any given shock: safe (Healthy), a liquidator could act now (Liquidatable on Aave, Eligible on Fluid), or too far gone for liquidation to help (Toxic).",
        technical: "Healthy: HF ≥ 1. Liquidatable/Eligible: HF < 1 but LTV still under the UC frontier. Toxic: LTV has crossed the UC frontier - always a strict subset of Liquidatable/Eligible.",
        shownIn: "Overview drilldown, Methodology",
      },
    ],
  },
  {
    heading: "Cross-protocol comparison metrics",
    entries: [
      {
        term: "Liquidatable/eligible (%)",
        plain: "Share of positions that could be liquidated right now, at this shock size.",
        technical: "Liquidatable/eligible count as a percentage of each protocol's own sampled book - stays comparable across very differently-sized real samples.",
        shownIn: "Overview chart",
      },
      {
        term: "Toxic (%)",
        plain: "Share of positions where liquidating them now would only make things worse.",
        technical: "Toxic count as a percentage of the sampled book. Always a subset of liquidatable/eligible.",
        shownIn: "Overview chart",
      },
      {
        term: "Liquidatable collateral (%)",
        plain: "Share of total collateral value sitting in at-risk positions, in dollar terms rather than headcount.",
        technical: "Same idea as the count-based metric, applied to collateral value - more sensitive to a single large position.",
        shownIn: "Overview chart",
      },
      {
        term: "Concentration",
        plain: "How much of the at-risk collateral sits in just one position - high means one whale dominates the picture.",
        technical: "The single largest at-risk position's share of all at-risk collateral, at a given shock.",
        shownIn: "Overview chart & drilldown",
      },
      {
        term: "Bad-debt severity",
        plain: "How much of a position's debt could be wiped out if the liquidator gets it slightly wrong.",
        technical: "The median debt/collateral ratio among only the positions actually underwater, not a summed dollar total.",
        shownIn: "Overview chart & drilldown",
      },
      {
        term: "Headroom (kill-price)",
        plain: "How big a price drop it typically takes to push a position into trouble.",
        technical: "Per position, the shock magnitude at which it first crosses its own threshold, shown as a distribution (median).",
        shownIn: "Overview drilldown",
      },
      {
        term: "Bad debt (Level 2 approximation)",
        plain: "A simplified estimate of debt that couldn't be recovered - real, but not the exact contract math.",
        technical: "max(0, debt − collateral) at the shocked price. Does not replicate the real contract's close-factor limits or per-asset seizure mechanics.",
        shownIn: "Overview drilldown",
      },
      {
        term: "Close factor",
        plain: "A cap most lending protocols put on how much of a single position's debt can be repaid in one liquidation call.",
        technical: "The real contract's close-factor limit (e.g. 50% at a time, with real Aave-specific exceptions this tool's Level 2 approximation doesn't replicate).",
        shownIn: "Methodology",
      },
    ],
  },
  {
    heading: "Validation statuses - is the math actually right?",
    entries: [
      {
        term: "Matched / Matched (within drift)",
        plain: "The real contract's output matched what was expected - exactly, or within a tiny, explained margin (a block's worth of real interest accrual).",
        technical: "actualDebtRepaid === expectedDebtRepaid exactly, or within 0.05% relative difference.",
        shownIn: "Validation tab",
      },
      {
        term: "Swept",
        plain: "Fluid's real liquidate() call reported it would sweep this position, with a real, decoded amount.",
        technical: "A real FluidLiquidateResult revert (the built-in dry-run signal) decoded successfully.",
        shownIn: "Validation tab",
      },
      {
        term: "Mismatched",
        plain: "The real contract's output genuinely differed from what was expected - a real problem, not explained drift.",
        technical: "A relative difference above the negligible-drift threshold between expected and actual amounts.",
        shownIn: "Validation tab",
      },
      {
        term: "Unexpected revert",
        plain: "The real call failed for a real, identified (or honestly reported as unidentified) reason.",
        technical: "A decoded custom error/Error(string), or the raw selector if not yet identified - never silently swallowed.",
        shownIn: "Validation tab",
      },
      {
        term: "Not applicable / Unable to validate",
        plain: "A disclosed real limit of what this deploy can check - not a hidden failure.",
        technical: "E.g. a vault whose oracle isn't the supported hop pattern, or an eth_call too large for this RPC tier.",
        shownIn: "Validation tab",
      },
    ],
  },
  {
    heading: "Profitability - is it worth a real liquidator's gas?",
    entries: [
      {
        term: "Gas used / Gas cost",
        plain: "How much real computation the liquidation transaction takes, and what that costs in dollars right now.",
        technical: "A real eth_estimateGas result, converted to USD via the real current gas price and the real ETH/USD price under the same shock scenario as everything else in the row.",
        shownIn: "Validation tab - profitability section",
      },
      {
        term: "Debt cleared",
        plain: "The real dollar value of debt the liquidator repays.",
        technical: "The real repaid amount, priced at the shocked debt-asset price.",
        shownIn: "Validation tab - profitability section",
      },
      {
        term: "Bonus received",
        plain: "The real dollar value of collateral the liquidator receives in exchange - always somewhat more than the debt cleared, that premium is the incentive to liquidate at all.",
        technical: "Collateral seized, priced at the shocked collateral-asset price (Aave: analytically from the real bonus multiplier; Fluid: the real amount from a dry-run check).",
        shownIn: "Validation tab - profitability section",
      },
      {
        term: "Net profit",
        plain: "Bonus received minus debt cleared minus gas cost - the real bottom line for a liquidator.",
        technical: "bonusValueUsd − debtClearedUsd − gasCostUsd, all priced under the same shocked-price vector.",
        shownIn: "Validation tab - profitability section",
      },
      {
        term: "Profitable / Unprofitable",
        plain: "Whether a real liquidator would actually come out ahead after gas, at this shock magnitude.",
        technical: "netProfitUsd > 0 or ≤ 0. Rows sweep a magnitude ladder and stop at the first profitable point, so a position with several rows shows its real path from unprofitable to profitable.",
        shownIn: "Validation tab - profitability section",
      },
    ],
  },
  {
    heading: "Mainnet-fork tier - real, mined-transaction checks",
    entries: [
      {
        term: "A's real tx",
        plain: "Whether the real liquidation this check depends on actually succeeded when mined.",
        technical: "The receipt status of a real, mined transaction on a real ephemeral anvil fork - \"reverted\" means chaining wasn't testable for this pair/vault, disclosed rather than hidden.",
        shownIn: "Cascade detail tab",
      },
      {
        term: "B isolated / B chained",
        plain: "The same check on position/vault B, once before and once after A's real liquidation was mined - comparing them is the whole point of this tier.",
        technical: "\"Isolated\": B's real liquidation-call check on the fork before A is mined. \"Chained\": the identical check on the same fork after A's real transaction is mined. Neither is a fork-required check on its own - the comparison between them is.",
        shownIn: "Cascade detail tab",
      },
      {
        term: "Real diff / Real diff (%)",
        plain: "How much B's result actually changed because A's liquidation really happened - something no isolated test can ever show.",
        technical: "chainedDebtRepaid − isolatedDebtRepaid, both as a raw signed amount and as a percentage of the isolated baseline. Aave: typically tiny (~0.000001%, real reserve-index drift). Fluid: typically -100% (full tick consumption, liquidate() is vault-level not per-position, so a repeat identical request finds nothing left).",
        shownIn: "Cascade detail tab",
      },
      {
        term: "Peg-trust mode / Configured max down / Real measured drop",
        plain: "A real, deliberate per-asset choice: does this vault trust a depegged price will recover (and accept temporary bad debt while it waits), or does it liquidate on a real depeg instead? Not a pass/fail check - both are legitimate configurations for different real risk profiles.",
        technical: "avoidForcedLiquidationsCol_ (a real, per-asset, guardian/governance-flippable flag - true = hold the capped rate through a depeg, bad-debt-tolerant; false = let the real rate through immediately, bad-debt-avoidant - confirmed the deliberate default new vault deployments ship with, reserved for assets not considered safe to assume a temporary depeg on), maxDownFromMaxReachedPercentCol_ (1e6-scale, only relevant when the flag is true), and the real, measured percentage drop in getExchangeRateLiquidate()'s reported rate once a real heartbeat has genuinely elapsed on a fork.",
        shownIn: "Cascade detail tab",
      },
      {
        term: "Liquidates on depeg (default) / Clamped as designed / Unclamped beyond bound",
        plain: "The real verdict for a tested vault: for a peg-trust-off vault, correctly letting a real crash through immediately (the expected, safe behavior) - or, for a peg-trust-on vault, whether its cap held or - genuinely concerning - didn't.",
        technical: "\"Liquidates on depeg (default)\": avoidForcedLiquidationsCol_ is false, so the down-cap branch never runs for this vault, by design - real crashes propagate immediately, triggering real liquidation rather than accumulating bad debt. \"Clamped as designed\": the flag is true and the real measured drop stayed within the configured bound. \"Unclamped beyond bound\": the flag is true but the real drop exceeded it - not expected.",
        shownIn: "Cascade detail tab",
      },
    ],
  },
];

export function Glossary() {
  return (
    <div>
      {SECTIONS.map((section) => (
        <div key={section.heading} style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "0.95rem", marginBottom: "0.6rem" }}>{section.heading}</h3>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Plain language</th>
                  <th>Technical</th>
                  <th>Shown in</th>
                </tr>
              </thead>
              <tbody>
                {section.entries.map((entry) => (
                  <tr key={entry.term}>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{entry.term}</td>
                    <td style={{ maxWidth: "260px" }}>{entry.plain}</td>
                    <td className="provenance" style={{ maxWidth: "320px" }}>{entry.technical}</td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.78rem", whiteSpace: "nowrap" }}>{entry.shownIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
