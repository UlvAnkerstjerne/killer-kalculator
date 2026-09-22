/**
 * Canonical product-metrics engine for Killer Kalculator.
 *
 * UMD wrapper — works in Node.js (CommonJS) and in the browser (window.ProductMetrics).
 *
 * Classification is by explicit product ID only — never by product name.
 * All product IDs are stored as strings for reliable Set membership testing.
 *
 * Reference: docs/metric-spec.md
 * Fixture:   test/fixtures/norrebro-2026-09-20.fixture.json (466 lines)
 */
/* global define */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();            // Node.js / CommonJS
  } else {
    root.ProductMetrics = factory();       // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Product ID registry ─────────────────────────────────────────────────────

  var PRODUCT_IDS = {
    // ── Kombos ───────────────────────────────────────────────────────────────
    // The kombo header line IS the roll; no separate roll component.
    // price ≠ 0 required: price = 0 means staff meal / comp; price < 0 means refund.
    KOMBO_LAMB:     '27242208',
    KOMBO_FALAFEL:  '27242204',

    // ── Standalone rolls ─────────────────────────────────────────────────────
    // Includes rolls sold alongside kombos in mixed orders.
    // price ≠ 0 required (same staff-meal and refund semantics as kombos).
    ROLL_KEBAB:     '27242336',
    ROLL_FALAFEL:   '27242332',

    // ── Lemonade ─────────────────────────────────────────────────────────────
    // All three variants are counted with no price filter.
    // Refunds (count < 0) subtract from the total.
    LEM_ADDON:      '27242080',   // + Lemonade (kombo addon)
    LEM_UPGRADE:    '27242148',   // + Killer Lemonade (kombo upgrade, +10 kr)
    LEM_STANDALONE: '27242164',   // Killer Lemonade (35 kr)

    // ── Bowls (excluded from roll and kombo counts) ──────────────────────────
    // No bowl products in the Nørrebro 2026-09-20 reference dataset.
    // IDs to be added here when identified from other stores or OnlinePOS catalogue.

    // ── Confirmed other-drink products (NOT lemonade) ────────────────────────
    // These are documented here explicitly so that future maintainers cannot
    // accidentally add them to LEM_IDS.  Decision confirmed 2026-09-22.
    OTHER_LOVER:       '29838736',  // Lover — a different drink, not lemonade
    OTHER_LOVER_ADDON: '29843293',  // + Lover (+10 kr) — not lemonade

    // ── Unclassified external lines ──────────────────────────────────────────
    // 29569042 — "Unknown external product" (single 4 DKK Wolt line in fixture)
    // Not counted in any metric; kept here as a documentation anchor.
  };

  // Derived sets for fast O(1) membership testing.
  var KOMBO_IDS = new Set([PRODUCT_IDS.KOMBO_LAMB, PRODUCT_IDS.KOMBO_FALAFEL]);
  var ROLL_IDS  = new Set([PRODUCT_IDS.ROLL_KEBAB,  PRODUCT_IDS.ROLL_FALAFEL]);
  var LEM_IDS   = new Set([PRODUCT_IDS.LEM_ADDON, PRODUCT_IDS.LEM_UPGRADE, PRODUCT_IDS.LEM_STANDALONE]);
  var BOWL_IDS  = new Set();   // populated when bowl products are identified

  // All known IDs — useful for detecting unknown IDs in the input.
  var ALL_KNOWN_IDS = new Set([].concat(
    Array.from(KOMBO_IDS),
    Array.from(ROLL_IDS),
    Array.from(LEM_IDS),
    Array.from(BOWL_IDS)
  ));

  // ── computeMetrics ──────────────────────────────────────────────────────────

  /**
   * Compute product metrics from an array of processed sales lines.
   *
   * Each line must have:
   *   productid   {number|string}  OnlinePOS product ID
   *   count       {number}         Signed quantity (negative for refunds)
   *   price       {number}         Signed line total incl. VAT (0 for staff meals)
   *
   * Returns:
   *   komboUnits  — net paid kombo units (price ≠ 0, signed count summed)
   *   rollUnits   — net paid standalone-roll units (price ≠ 0, signed count summed)
   *   komboPct    — komboUnits / (komboUnits + rollUnits) × 100, or null if denom = 0
   *   lemUnits    — net lemonade units (no price filter, signed count summed)
   *   breakdown   — per-product-ID unit counts
   */
  function computeMetrics(lines) {
    var komboUnits = 0;
    var rollUnits  = 0;
    var lemUnits   = 0;

    var breakdown = {
      komboLamb:     0,
      komboFalafel:  0,
      rollKebab:     0,
      rollFalafel:   0,
      lemAddon:      0,
      lemUpgrade:    0,
      lemStandalone: 0,
    };

    if (!Array.isArray(lines)) return _result(komboUnits, rollUnits, lemUnits, breakdown);

    for (var i = 0; i < lines.length; i++) {
      var line  = lines[i];
      var pid   = String(line.productid);
      var count = line.count  != null ? line.count  : 0;
      var price = line.price  != null ? line.price  : 0;

      if (KOMBO_IDS.has(pid)) {
        // Exclude zero-price lines (staff meals / fully-comped orders).
        // Refunds have price < 0 — included so signed count subtracts.
        if (price !== 0) {
          komboUnits += count;
          if (pid === PRODUCT_IDS.KOMBO_LAMB)    breakdown.komboLamb    += count;
          if (pid === PRODUCT_IDS.KOMBO_FALAFEL) breakdown.komboFalafel += count;
        }
      } else if (ROLL_IDS.has(pid)) {
        // Same semantics: exclude zero-price; include refunds.
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
    var denominator = komboUnits + rollUnits;
    var komboPct    = denominator !== 0 ? (komboUnits / denominator * 100) : null;
    return { komboUnits: komboUnits, rollUnits: rollUnits, komboPct: komboPct, lemUnits: lemUnits, breakdown: breakdown };
  }

  return {
    PRODUCT_IDS:   PRODUCT_IDS,
    KOMBO_IDS:     KOMBO_IDS,
    ROLL_IDS:      ROLL_IDS,
    LEM_IDS:       LEM_IDS,
    BOWL_IDS:      BOWL_IDS,
    ALL_KNOWN_IDS: ALL_KNOWN_IDS,
    computeMetrics: computeMetrics,
  };
}));
