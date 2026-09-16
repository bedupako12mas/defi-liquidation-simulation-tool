"use client";

/**
 * Every metric/status shown anywhere in this app, in one scannable reference - a
 * complement to the inline InfoTooltips scattered across Overview/Methodology/Validation
 * (those explain a term where it's used; this is the "I saw a word somewhere, what did it
 * mean" central lookup). Grouped by where each term actually appears, not alphabetically -
 * a reader arriving from a specific tab can find the relevant section directly.
 */

import { useEffect, useRef, useState } from "react";

interface GlossaryEntry {
  /** Stable anchor id - referenced by InfoTooltip's glossaryId prop elsewhere in the app to
   *  jump straight to this row. Keep stable once published; other files hardcode these. */
  id: string;
  term: string;
  plain: string;
  technical: string;
  /** The term's formula/computation, kept separate from `technical` prose so it's always
   *  scannable in its own column rather than embedded mid-paragraph. Left unset for
   *  qualitative entries (status labels, config flags) that have no formula. */
  formula?: string;
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
        id: "hf",
        term: "Health factor (HF)",
        plain: "A single number for how safe a position is. Above 1 is safe; below 1 means it can be liquidated.",
        technical: "Empirically checked against Aave's own on-chain getUserAccountData() to within 10 bps on real positions.",
        formula: "HF = (collateral value × liquidation threshold) / debt value",
        shownIn: "Overview drilldown",
      },
      {
        id: "ltv",
        term: "LTV (loan-to-value)",
        plain: "How much is currently borrowed, as a share of collateral value.",
        technical: "The plain ratio of what's owed to what's posted, at current prices.",
        formula: "LTV = current debt / current collateral value",
        shownIn: "Overview drilldown",
      },
      {
        id: "liquidation-threshold",
        term: "Liquidation threshold",
        plain: "The LTV line past which a position becomes eligible for liquidation.",
        technical: "The protocol's own configured eligibility bar for a given asset - crossing it flips a position to Liquidatable/Eligible.",
        shownIn: "Overview drilldown, Methodology's UC frontier table",
      },
      {
        id: "uc-frontier",
        term: "UC frontier (undercollateralization frontier)",
        plain: "A second, much higher line - past it, liquidating a position can no longer make it healthier, only less bad.",
        technical: "A direct algebraic consequence of a fixed proportional liquidation bonus. Crossing it flips a position to Toxic.",
        formula: "LTV_UC = 1 / (1 + i), for liquidation incentive i",
        shownIn: "Overview drilldown, Methodology",
      },
      {
        id: "state",
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
        id: "liquidatable-pct",
        term: "Liquidatable/eligible (%)",
        plain: "Share of positions that could be liquidated right now, at this shock size.",
        technical: "Stays comparable across very differently-sized real samples (e.g. Aave's small sample vs. Fluid's much larger one).",
        formula: "liquidatable/eligible count / total sampled positions × 100",
        shownIn: "Overview chart",
      },
      {
        id: "toxic-pct",
        term: "Toxic (%)",
        plain: "Share of positions where liquidating them now would only make things worse.",
        technical: "Always a subset of liquidatable/eligible - never a separate condition reached independently.",
        formula: "toxic count / total sampled positions × 100",
        shownIn: "Overview chart",
      },
      {
        id: "liquidatable-collateral-pct",
        term: "Liquidatable collateral (%)",
        plain: "Share of total collateral value sitting in at-risk positions, in dollar terms rather than headcount.",
        technical: "Same idea as the count-based metric, applied to collateral value - more sensitive to a single large position.",
        formula: "at-risk collateral USD / total collateral USD × 100",
        shownIn: "Overview chart",
      },
      {
        id: "concentration",
        term: "Concentration",
        plain: "How much of the at-risk collateral sits in just one position - high means one whale dominates the picture.",
        technical: "High concentration means a dollar swing is a single-position artifact, not a broad signal; low, stable concentration means it is.",
        formula: "largest at-risk position's collateral USD / total at-risk collateral USD × 100",
        shownIn: "Overview chart & drilldown",
      },
      {
        id: "bad-debt-severity",
        term: "Bad-debt severity",
        plain: "How much of a position's debt could be wiped out if the liquidator gets it slightly wrong.",
        technical: "Separates \"many positions barely underwater\" from \"one position catastrophically underwater,\" which a single summed total conflates.",
        formula: "median(debt / collateral) across underwater positions only",
        shownIn: "Overview chart & drilldown",
      },
      {
        id: "headroom",
        term: "Headroom (kill-price)",
        plain: "How big a price drop it typically takes to push a position into trouble.",
        technical: "Shown as a distribution (median) rather than a single swept curve - robust to sample size and outlier positions.",
        formula: "median(shock magnitude at which a position first crosses its own threshold)",
        shownIn: "Overview drilldown",
      },
      {
        id: "bad-debt-approx",
        term: "Bad debt (Level 2 approximation)",
        plain: "A simplified estimate of debt that couldn't be recovered - real, but not the exact contract math.",
        technical: "Does not replicate the real contract's close-factor limits or per-asset seizure mechanics.",
        formula: "max(0, debt − collateral), at the shocked price",
        shownIn: "Overview drilldown",
      },
      {
        id: "close-factor",
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
        id: "matched",
        term: "Matched / Matched (within drift)",
        plain: "The real contract's output matched what was expected - exactly, or within a tiny, explained margin (a block's worth of real interest accrual).",
        technical: "\"Within drift\" allows up to 0.05% relative difference before it counts as a real mismatch.",
        formula: "actualDebtRepaid === expectedDebtRepaid, or within 0.05% relative difference",
        shownIn: "Validation tab",
      },
      {
        id: "swept",
        term: "Swept",
        plain: "Fluid's real liquidate() call reported it would sweep this position, with a real, decoded amount.",
        technical: "A real FluidLiquidateResult revert (the built-in dry-run signal) decoded successfully.",
        shownIn: "Validation tab",
      },
      {
        id: "mismatched",
        term: "Mismatched",
        plain: "The real contract's output genuinely differed from what was expected - a real problem, not explained drift.",
        technical: "A relative difference above the negligible-drift threshold between expected and actual amounts.",
        shownIn: "Validation tab",
      },
      {
        id: "unexpected-revert",
        term: "Unexpected revert",
        plain: "The real call failed for a real, identified (or honestly reported as unidentified) reason.",
        technical: "A decoded custom error/Error(string), or the raw selector if not yet identified - never silently swallowed.",
        shownIn: "Validation tab",
      },
      {
        id: "not-applicable",
        term: "Not applicable / Unable to validate",
        plain: "A disclosed real limit of what this deploy can check - not a hidden failure.",
        technical: "E.g. a vault whose oracle isn't the supported hop pattern, or an eth_call too large for this RPC tier.",
        shownIn: "Validation tab",
      },
    ],
  },
  {
    heading: "Gas & profitability - is it worth a real liquidator's gas?",
    entries: [
      {
        id: "gas-cost",
        term: "Gas used / Gas cost",
        plain: "How much real computation the liquidation transaction takes, and what that costs in dollars right now.",
        technical: "A real eth_estimateGas result, converted to USD via the real current gas price and the real ETH/USD price under the same shock scenario as everything else in the row.",
        formula: "gas cost USD = gasUsed × real gas price (gwei) × real ETH/USD price",
        shownIn: "Overview & Validation tab - gas/profitability section",
      },
      {
        id: "debt-cleared",
        term: "Debt cleared",
        plain: "The real dollar value of debt the liquidator repays.",
        technical: "The real repaid amount, priced at the shocked debt-asset price.",
        formula: "debt cleared USD = real repaid amount × shocked debt-asset price",
        shownIn: "Overview & Validation tab - gas/profitability section",
      },
      {
        id: "bonus-received",
        term: "Bonus received",
        plain: "The real dollar value of collateral the liquidator receives in exchange - always somewhat more than the debt cleared, that premium is the incentive to liquidate at all.",
        technical: "Collateral seized, priced at the shocked collateral-asset price (Aave: analytically from the real bonus multiplier; Fluid: the real amount from a dry-run check).",
        formula: "bonus USD = collateral seized × shocked collateral-asset price",
        shownIn: "Overview & Validation tab - gas/profitability section",
      },
      {
        id: "net-profit",
        term: "Net profit",
        plain: "Bonus received minus debt cleared minus gas cost - the real bottom line for a liquidator.",
        technical: "All three terms priced under the same shocked-price vector, so the comparison is apples-to-apples.",
        formula: "net profit USD = bonusValueUsd − debtClearedUsd − gasCostUsd",
        shownIn: "Overview & Validation tab - gas/profitability section",
      },
      {
        id: "profitable",
        term: "Profitable / Unprofitable",
        plain: "Whether a real liquidator would actually come out ahead after gas, at this shock magnitude.",
        technical: "Rows sweep a magnitude ladder and stop at the first profitable point, so a position with several rows shows its real path from unprofitable to profitable.",
        formula: "profitable ⟺ net profit USD > 0",
        shownIn: "Overview & Validation tab - gas/profitability section",
      },
    ],
  },
  {
    heading: "Mainnet-fork tier - real, mined-transaction checks",
    entries: [
      {
        id: "real-tx",
        term: "A's real tx",
        plain: "Whether the real liquidation this check depends on actually succeeded when mined.",
        technical: "The receipt status of a real, mined transaction on a real ephemeral anvil fork - \"reverted\" means chaining wasn't testable for this pair/vault, disclosed rather than hidden.",
        shownIn: "Cascade detail tab",
      },
      {
        id: "isolated-chained",
        term: "B isolated / B chained",
        plain: "The same check on position/vault B, once before and once after A's real liquidation was mined - comparing them is the whole point of this tier.",
        technical: "\"Isolated\": B's real liquidation-call check on the fork before A is mined. \"Chained\": the identical check on the same fork after A's real transaction is mined. Neither is a fork-required check on its own - the comparison between them is.",
        shownIn: "Cascade detail tab",
      },
      {
        id: "real-diff",
        term: "Real diff / Real diff (%)",
        plain: "How much B's result actually changed because A's liquidation really happened - something no isolated test can ever show.",
        technical: "Aave: typically tiny (~0.000001%, real reserve-index drift). Fluid: typically -100% (full tick consumption, liquidate() is vault-level not per-position, so a repeat identical request finds nothing left).",
        formula: "real diff = chainedDebtRepaid − isolatedDebtRepaid (also shown as % of the isolated baseline)",
        shownIn: "Cascade detail tab",
      },
      {
        id: "peg-trust-mode",
        term: "Peg-trust mode / Configured max down / Real measured drop",
        plain: "A real, deliberate per-asset choice: does this vault trust a depegged price will recover (and accept temporary bad debt while it waits), or does it liquidate on a real depeg instead? Not a pass/fail check - both are legitimate configurations for different real risk profiles.",
        technical: "avoidForcedLiquidationsCol_ (a real, per-asset, guardian/governance-flippable flag - true = hold the capped rate through a depeg, bad-debt-tolerant; false = let the real rate through immediately, bad-debt-avoidant - confirmed the deliberate default new vault deployments ship with, reserved for assets not considered safe to assume a temporary depeg on), maxDownFromMaxReachedPercentCol_ (1e6-scale, only relevant when the flag is true), and the real, measured percentage drop in getExchangeRateLiquidate()'s reported rate once a real heartbeat has genuinely elapsed on a fork.",
        shownIn: "Cascade detail tab",
      },
      {
        id: "cap-verdict",
        term: "Liquidates on depeg (default) / Clamped as designed / Unclamped beyond bound",
        plain: "The real verdict for a tested vault: for a peg-trust-off vault, correctly letting a real crash through immediately (the expected, safe behavior) - or, for a peg-trust-on vault, whether its cap held or - genuinely concerning - didn't.",
        technical: "\"Liquidates on depeg (default)\": avoidForcedLiquidationsCol_ is false, so the down-cap branch never runs for this vault, by design - real crashes propagate immediately, triggering real liquidation rather than accumulating bad debt. \"Clamped as designed\": the flag is true and the real measured drop stayed within the configured bound. \"Unclamped beyond bound\": the flag is true but the real drop exceeded it - not expected.",
        shownIn: "Cascade detail tab",
      },
    ],
  },
];

export function Glossary({ activeAnchor }: { activeAnchor?: string | null }) {
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
                  <th>Formula</th>
                  <th>Technical</th>
                  <th>Shown in</th>
                </tr>
              </thead>
              <tbody>
                {section.entries.map((entry) => (
                  <GlossaryRow key={entry.id} entry={entry} highlighted={entry.id === activeAnchor} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function GlossaryRow({ entry, highlighted }: { entry: GlossaryEntry; highlighted: boolean }) {
  const rowRef = useRef<HTMLTableRowElement>(null);

  // "Adjust state while rendering" (React's own recommended pattern for "flash briefly when
  // a prop changes") rather than setting it from inside an effect - turning the flash ON
  // needs to happen the instant `highlighted` becomes true, synchronously with that render,
  // not one render later via an effect (which is also what react-hooks/set-state-in-effect
  // flags: an effect that calls setState unconditionally at its top is a smell for exactly
  // this "should've been derived during render" case).
  const [prevHighlighted, setPrevHighlighted] = useState(highlighted);
  const [flash, setFlash] = useState(highlighted);
  if (highlighted !== prevHighlighted) {
    setPrevHighlighted(highlighted);
    if (highlighted) setFlash(true);
  }

  // Turning the flash back OFF, and the initial scroll, are genuine effects (a timer and a
  // DOM call) - the debounce pattern already used elsewhere in this file/PositionDrilldown's
  // slider (setState from inside a setTimeout callback, not synchronously in the effect body).
  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), 2000);
    return () => clearTimeout(timer);
  }, [flash]);

  return (
    <tr id={entry.id} ref={rowRef} className={flash ? "glossary-row--highlight" : undefined}>
      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{entry.term}</td>
      <td style={{ maxWidth: "260px" }}>{entry.plain}</td>
      <td className="provenance" style={{ maxWidth: "220px", fontFamily: "monospace", fontSize: "0.75rem" }}>
        {entry.formula ?? "—"}
      </td>
      <td className="provenance" style={{ maxWidth: "320px" }}>{entry.technical}</td>
      <td style={{ color: "var(--text-muted)", fontSize: "0.78rem", whiteSpace: "nowrap" }}>{entry.shownIn}</td>
    </tr>
  );
}
