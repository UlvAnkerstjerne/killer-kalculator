'use strict';
/**
 * Canonical product-metrics engine for Killer Kalculator.
 *
 * Classification is by explicit product ID only — never by product name.
 * All product IDs are stored as strings for reliable Set membership testing.
 *
 * Reference: docs/metric-spec.md
 * Fixture:   test/fixtures/norrebro-2026-09-20.fixture.json (466 lines)
 */

// ── Product ID registry ───────────────────────────────────────────────────────

const PRODUCT_IDS = {
  // Kombos — the header line IS the roll; no separate roll component.
  // Paid units require price > 0; staff meals share the same ID at price 0.
  KOMBO_LAMB:     '27242208',
  KOMBO_FALAFEL:  '27242204',

  // Standalone rolls — includes rolls sold alongside kombos in mixed orders.
  // Paid units require price > 0; staff meals share the same ID at price 0.
  ROLL_KEBAB:     '27242336',
  ROLL_FALAFEL:   '27242332',

  // Lemonade — all three variants counted with no price filter.
  // Refunds (count < 0) subtract from the total.
  LEM_ADDON:      '27242080',   // + Lemonade (kombo addon)
  LEM_UPGRADE:    '27242148',   // + Killer Lemonade (kombo upgrade, +10 kr)
  LEM_STANDALONE: '27242164',   // Killer Lemonade (35 kr)

  // Bowls — excluded from roll and kombo counts.
  // No bowl products in the Nørrebro 2026-09-20 reference dataset.
  // IDs to be added here when identified on other stores or from OnlinePOS catalogue.
};

// Derived sets for fast O(1) membership testing.
const KOMBO_IDS = new Set([PRODUCT_IDS.KOMBO_LAMB, PRODUCT_IDS.KOMBO_FALAFEL]);
const ROLL_IDS  = new Set([PRODUCT_IDS.ROLL_KEBAB,  PRODUCT_IDS.ROLL_FALAFEL]);
const LEM_IDS   = new Set([PRODUCT_IDS.LEM_ADDON, PRODUCT_IDS.LEM_UPGRADE, PRODUCT_IDS.LEM_STANDALONE]);
const BOWL_IDS  = new Set();   // populated when bowl products are identified

// All known IDs — used to detect unknown IDs in the input.
const ALL_KNOWN_IDS = new Set([...KOMBO_IDS, ...ROLL_IDS, ...LEM_IDS, ...BOWL_IDS]);

// ── computeMetrics ────────────────────────────────────────────────────────────

/**
 * Compute product metrics from an array of processed sales lines.
 *
 * Each line must have:
 *   productid   {number|string}  OnlinePOS product ID
 *   count       {number}         Signed quantity (negative for refunds)
 *   price       {number}         Signed line total incl. VAT (0 for staff meals)
 *
 * Returns:
 *   komboUnits  — net paid kombo units (price > 0, signed count summed)
 *   rollUnits   — net paid standalone-roll units (price > 0, signed count summed)
 *   komboPct    — komboUnits / (komboUnits + rollUnits) × 100, or null if denominator = 0
 *   lemUnits    — net lemonade units (no price filter, signed count summed)
 *   breakdown   — per-product-ID unit counts
 */
function computeMetrics(lines) {
  let komboUnits = 0;
  let rollUnits  = 0;
  let lemUnits   = 0;

  const breakdown = {
    komboLamb:     0,
    komboFalafel:  0,
    rollKebab:     0,
    rollFalafel:   0,
    lemAddon:      0,
    lemUpgrade:    0,
    lemStandalone: 0,
  };

  if (!Array.isArray(lines)) return _result(komboUnits, rollUnits, lemUnits, breakdown);

  for (const line of lines) {
    const pid   = String(line.productid);
    const count = line.count  ?? 0;
    const price = line.price  ?? 0;

    if (KOMBO_IDS.has(pid)) {
      // Exclude zero-price lines (staff meals / fully-comped orders).
      // Refunds have price < 0 — they ARE included so that count (negative) subtracts.
      if (price !== 0) {
        komboUnits += count;
        if (pid === PRODUCT_IDS.KOMBO_LAMB)    breakdown.komboLamb    += count;
        if (pid === PRODUCT_IDS.KOMBO_FALAFEL) breakdown.komboFalafel += count;
      }
    } else if (ROLL_IDS.has(pid)) {
      // Same as kombos: exclude zero-price staff meals; include refunds (price < 0).
      if (price !== 0) {
        rollUnits += count;
        if (pid === PRODUCT_IDS.ROLL_KEBAB)   breakdown.rollKebab   += count;
        if (pid === PRODUCT_IDS.ROLL_FALAFEL) breakdown.rollFalafel += count;
      }
    } else if (LEM_IDS.has(pid)) {
      // All lemonade variants counted regardless of price.
      // Refunds (count < 0) subtract automatically.
      lemUnits += count;
      if (pid === PRODUCT_IDS.LEM_ADDON)      breakdown.lemAddon      += count;
      if (pid === PRODUCT_IDS.LEM_UPGRADE)    breakdown.lemUpgrade    += count;
      if (pid === PRODUCT_IDS.LEM_STANDALONE) breakdown.lemStandalone += count;
    }
    // BOWL_IDS: excluded from all counts (no-op intentional).
    // All other IDs: silently ignored — no name-based classification.
  }

  return _result(komboUnits, rollUnits, lemUnits, breakdown);
}

function _result(komboUnits, rollUnits, lemUnits, breakdown) {
  const denominator = komboUnits + rollUnits;
  const komboPct    = denominator > 0 ? (komboUnits / denominator * 100) : null;
  return { komboUnits, rollUnits, komboPct, lemUnits, breakdown };
}

module.exports = { PRODUCT_IDS, KOMBO_IDS, ROLL_IDS, LEM_IDS, BOWL_IDS, ALL_KNOWN_IDS, computeMetrics };
