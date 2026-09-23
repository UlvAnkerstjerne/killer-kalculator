/**
 * Canonical product-metrics engine for Killer Kalculator.
 *
 * UMD wrapper — works in Node.js (CommonJS) and in the browser (window.ProductMetrics).
 *
 * Classification is by explicit product ID only — never by product name.
 * All product IDs are stored as strings for reliable Set membership testing.
 *
 * Each OnlinePOS firmaid uses its own numeric IDs for the same physical product,
 * so every store has a separate entry here.  See docs/metric-spec.md for the
 * complete per-store catalogue and the confirmed business decisions.
 *
 * Reference: docs/metric-spec.md
 * Fixture:   test/fixtures/norrebro-2026-09-20.fixture.json (466 lines)
 * Audit:     Stage 4 Job 3 — 97 381 lines across 6 stores, 2026-08-23 → 2026-09-22
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
  //
  // Naming convention: BASE_KEY for Nørrebro (the original reference store),
  // BASE_KEY_STORE for all other stores.
  //
  // price ≠ 0 rule for kombos and rolls:
  //   price = 0  → staff meal / fully-comped order → excluded
  //   price < 0  → refund → included (signed count subtracts)
  //   price > 0  → paid sale → included
  //
  // Lemonade IDs use signed count with no price filter.

  var PRODUCT_IDS = {

    // ── Kombos — Lamb ──────────────────────────────────────────────────────────
    KOMBO_LAMB:                 '27242208',  // Nørrebro      firmaid 18095
    KOMBO_LAMB_INDRE_BY:        '27241816',  // Indre By      firmaid 15143
    KOMBO_LAMB_VESTERBRO:       '27240680',  // Vesterbro     firmaid 13205
    KOMBO_LAMB_CHRISTIANSHAVN:  '27859906',  // Christianshavn firmaid 21331
    KOMBO_LAMB_FISKETORVET:     '27241068',  // Fisketorvet   firmaid 18926
    KOMBO_LAMB_FREDERIKSBERG:   '27241432',  // Frederiksberg firmaid 18924

    // ── Kombos — Falafel ───────────────────────────────────────────────────────
    KOMBO_FALAFEL:                 '27242204',  // Nørrebro
    KOMBO_FALAFEL_INDRE_BY:        '27241812',
    KOMBO_FALAFEL_VESTERBRO:       '27240676',
    KOMBO_FALAFEL_CHRISTIANSHAVN:  '27859903',
    KOMBO_FALAFEL_FISKETORVET:     '27241064',
    KOMBO_FALAFEL_FREDERIKSBERG:   '27241428',

    // ── Kombos — Kylling ───────────────────────────────────────────────────────
    // Killer Kylling is sold only at Indre By, Christianshavn and Fisketorvet.
    // Vesterbro, Frederiksberg and Nørrebro do not carry this product.
    KOMBO_KYLLING_INDRE_BY:        '29838316',
    KOMBO_KYLLING_CHRISTIANSHAVN:  '29493147',
    KOMBO_KYLLING_FISKETORVET:     '29652666',

    // ── Standalone rolls — Kebab ───────────────────────────────────────────────
    ROLL_KEBAB:                    '27242336',  // Nørrebro
    ROLL_KEBAB_INDRE_BY:           '27241944',
    ROLL_KEBAB_VESTERBRO:          '27240808',
    ROLL_KEBAB_CHRISTIANSHAVN:     '27860038',
    ROLL_KEBAB_FISKETORVET:        '27241228',  // primary Fisketorvet ID
    ROLL_KEBAB_FISKETORVET_B:      '27241196',  // confirmed second ID, same product
    ROLL_KEBAB_FREDERIKSBERG:      '27241560',

    // ── Standalone rolls — Falafel ─────────────────────────────────────────────
    ROLL_FALAFEL:                  '27242332',  // Nørrebro
    ROLL_FALAFEL_INDRE_BY:         '27241940',
    ROLL_FALAFEL_VESTERBRO:        '27240804',
    ROLL_FALAFEL_CHRISTIANSHAVN:   '27860035',
    ROLL_FALAFEL_FISKETORVET:      '27241192',
    ROLL_FALAFEL_FREDERIKSBERG:    '27241556',

    // ── Standalone rolls — Kylling ─────────────────────────────────────────────
    ROLL_KYLLING_INDRE_BY:         '29838301',
    ROLL_KYLLING_CHRISTIANSHAVN:   '29493150',
    ROLL_KYLLING_FISKETORVET:      '29652669',

    // ── Lemonade — free included addon (+ Lemonade, included in kombo price) ───
    // Only Nørrebro, Fisketorvet and Frederiksberg emit a separate free-addon line.
    // Vesterbro, Indre By and Christianshavn confirmed no free lemonade line:
    // their kombos offer only the +10 kr upgrade or standalone purchase.
    LEM_ADDON:                     '27242080',  // Nørrebro
    LEM_ADDON_FISKETORVET:         '27240940',
    LEM_ADDON_FREDERIKSBERG:       '27241304',

    // ── Lemonade — paid upgrade (+ Killer Lemonade, +10 kr) ───────────────────
    LEM_UPGRADE:                   '27242148',  // Nørrebro
    LEM_UPGRADE_INDRE_BY:          '27241756',
    LEM_UPGRADE_VESTERBRO:         '27240620',
    LEM_UPGRADE_CHRISTIANSHAVN:    '27859873',
    LEM_UPGRADE_FISKETORVET:       '27241008',
    LEM_UPGRADE_FREDERIKSBERG:     '27241372',

    // ── Lemonade — standalone (Killer Lemonade, 35 kr) ────────────────────────
    LEM_STANDALONE:                '27242164',  // Nørrebro
    LEM_STANDALONE_INDRE_BY:       '27241772',
    LEM_STANDALONE_VESTERBRO:      '27240636',
    LEM_STANDALONE_CHRISTIANSHAVN: '27859885',
    LEM_STANDALONE_FISKETORVET:    '27241024',
    LEM_STANDALONE_FREDERIKSBERG:  '27241388',

    // ── Bowls (excluded from roll and kombo counts) ────────────────────────────
    // No bowl products found in the cross-store audit (30 days, all 6 stores).
    // IDs must be added explicitly when confirmed from OnlinePOS catalogue.

    // ── Confirmed other-drink products (NOT lemonade) ──────────────────────────
    // Decision confirmed 2026-09-22: Lover is a different drink, not lemonade.
    // All store-specific Lover IDs are listed here so future maintainers cannot
    // accidentally add any of them to LEM_IDS.
    OTHER_LOVER:                      '29838736',  // Nørrebro
    OTHER_LOVER_VESTERBRO:            '29838742',
    OTHER_LOVER_CHRISTIANSHAVN:       '29838682',
    OTHER_LOVER_FISKETORVET:          '29838706',
    OTHER_LOVER_FREDERIKSBERG:        '29838724',
    OTHER_LOVER_INDRE_BY:             '29838730',

    OTHER_LOVER_ADDON:                '29843293',  // Nørrebro  "+ Lover (+10 kr)"
    OTHER_LOVER_ADDON_VESTERBRO:      '29843296',
    OTHER_LOVER_ADDON_CHRISTIANSHAVN: '29838694',  // name variant: "+ Lover ( 10 kr )"
    OTHER_LOVER_ADDON_FISKETORVET:    '29843302',
    OTHER_LOVER_ADDON_FREDERIKSBERG:  '29843299',
    OTHER_LOVER_ADDON_INDRE_BY:       '29843290',

    // ── Unclassified external lines ────────────────────────────────────────────
    // 29569042 — "Unknown external product" (Nørrebro, Wolt, 4 DKK)
    // 29553679 — "Unknown external product" (Christianshavn, high volume)
    // 29557357 — "Unknown external product" (Fisketorvet)
    // 29557363 — "Unknown external product" (Indre By)
    // 30528491 — "Unknown external product" (Indre By)
    // All unclassified and excluded; kept here as documentation anchors.
  };

  // ── Category-level Sets ─────────────────────────────────────────────────────
  // Each protein/product type gets its own Set for fast O(1) sub-classification.
  // The top-level KOMBO_IDS / ROLL_IDS / LEM_IDS are unions of these sub-sets.

  var KOMBO_LAMB_IDS = new Set([
    PRODUCT_IDS.KOMBO_LAMB,
    PRODUCT_IDS.KOMBO_LAMB_INDRE_BY,
    PRODUCT_IDS.KOMBO_LAMB_VESTERBRO,
    PRODUCT_IDS.KOMBO_LAMB_CHRISTIANSHAVN,
    PRODUCT_IDS.KOMBO_LAMB_FISKETORVET,
    PRODUCT_IDS.KOMBO_LAMB_FREDERIKSBERG,
  ]);

  var KOMBO_FALAFEL_IDS = new Set([
    PRODUCT_IDS.KOMBO_FALAFEL,
    PRODUCT_IDS.KOMBO_FALAFEL_INDRE_BY,
    PRODUCT_IDS.KOMBO_FALAFEL_VESTERBRO,
    PRODUCT_IDS.KOMBO_FALAFEL_CHRISTIANSHAVN,
    PRODUCT_IDS.KOMBO_FALAFEL_FISKETORVET,
    PRODUCT_IDS.KOMBO_FALAFEL_FREDERIKSBERG,
  ]);

  var KOMBO_KYLLING_IDS = new Set([
    PRODUCT_IDS.KOMBO_KYLLING_INDRE_BY,
    PRODUCT_IDS.KOMBO_KYLLING_CHRISTIANSHAVN,
    PRODUCT_IDS.KOMBO_KYLLING_FISKETORVET,
  ]);

  // Union: all kombo IDs across all stores and proteins.
  var KOMBO_IDS = new Set([].concat(
    Array.from(KOMBO_LAMB_IDS),
    Array.from(KOMBO_FALAFEL_IDS),
    Array.from(KOMBO_KYLLING_IDS)
  ));

  var ROLL_KEBAB_IDS = new Set([
    PRODUCT_IDS.ROLL_KEBAB,
    PRODUCT_IDS.ROLL_KEBAB_INDRE_BY,
    PRODUCT_IDS.ROLL_KEBAB_VESTERBRO,
    PRODUCT_IDS.ROLL_KEBAB_CHRISTIANSHAVN,
    PRODUCT_IDS.ROLL_KEBAB_FISKETORVET,
    PRODUCT_IDS.ROLL_KEBAB_FISKETORVET_B,
    PRODUCT_IDS.ROLL_KEBAB_FREDERIKSBERG,
  ]);

  var ROLL_FALAFEL_IDS = new Set([
    PRODUCT_IDS.ROLL_FALAFEL,
    PRODUCT_IDS.ROLL_FALAFEL_INDRE_BY,
    PRODUCT_IDS.ROLL_FALAFEL_VESTERBRO,
    PRODUCT_IDS.ROLL_FALAFEL_CHRISTIANSHAVN,
    PRODUCT_IDS.ROLL_FALAFEL_FISKETORVET,
    PRODUCT_IDS.ROLL_FALAFEL_FREDERIKSBERG,
  ]);

  var ROLL_KYLLING_IDS = new Set([
    PRODUCT_IDS.ROLL_KYLLING_INDRE_BY,
    PRODUCT_IDS.ROLL_KYLLING_CHRISTIANSHAVN,
    PRODUCT_IDS.ROLL_KYLLING_FISKETORVET,
  ]);

  // Union: all standalone roll IDs across all stores and proteins.
  var ROLL_IDS = new Set([].concat(
    Array.from(ROLL_KEBAB_IDS),
    Array.from(ROLL_FALAFEL_IDS),
    Array.from(ROLL_KYLLING_IDS)
  ));

  var LEM_ADDON_IDS = new Set([
    PRODUCT_IDS.LEM_ADDON,
    PRODUCT_IDS.LEM_ADDON_FISKETORVET,
    PRODUCT_IDS.LEM_ADDON_FREDERIKSBERG,
  ]);

  var LEM_UPGRADE_IDS = new Set([
    PRODUCT_IDS.LEM_UPGRADE,
    PRODUCT_IDS.LEM_UPGRADE_INDRE_BY,
    PRODUCT_IDS.LEM_UPGRADE_VESTERBRO,
    PRODUCT_IDS.LEM_UPGRADE_CHRISTIANSHAVN,
    PRODUCT_IDS.LEM_UPGRADE_FISKETORVET,
    PRODUCT_IDS.LEM_UPGRADE_FREDERIKSBERG,
  ]);

  var LEM_STANDALONE_IDS = new Set([
    PRODUCT_IDS.LEM_STANDALONE,
    PRODUCT_IDS.LEM_STANDALONE_INDRE_BY,
    PRODUCT_IDS.LEM_STANDALONE_VESTERBRO,
    PRODUCT_IDS.LEM_STANDALONE_CHRISTIANSHAVN,
    PRODUCT_IDS.LEM_STANDALONE_FISKETORVET,
    PRODUCT_IDS.LEM_STANDALONE_FREDERIKSBERG,
  ]);

  // Union: all lemonade IDs across all stores and variants.
  var LEM_IDS = new Set([].concat(
    Array.from(LEM_ADDON_IDS),
    Array.from(LEM_UPGRADE_IDS),
    Array.from(LEM_STANDALONE_IDS)
  ));

  var BOWL_IDS = new Set();   // populated when bowl products are identified

  // All actively-counted IDs — useful for detecting unknown IDs in input.
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
   *   breakdown   — per-category unit counts across all stores
   */
  function computeMetrics(lines) {
    var komboUnits = 0;
    var rollUnits  = 0;
    var lemUnits   = 0;

    var breakdown = {
      komboLamb:     0,
      komboFalafel:  0,
      komboKylling:  0,
      rollKebab:     0,
      rollFalafel:   0,
      rollKylling:   0,
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
          if (KOMBO_LAMB_IDS.has(pid))    breakdown.komboLamb    += count;
          if (KOMBO_FALAFEL_IDS.has(pid)) breakdown.komboFalafel += count;
          if (KOMBO_KYLLING_IDS.has(pid)) breakdown.komboKylling += count;
        }
      } else if (ROLL_IDS.has(pid)) {
        // Same semantics: exclude zero-price; include refunds.
        if (price !== 0) {
          rollUnits += count;
          if (ROLL_KEBAB_IDS.has(pid))   breakdown.rollKebab   += count;
          if (ROLL_FALAFEL_IDS.has(pid)) breakdown.rollFalafel += count;
          if (ROLL_KYLLING_IDS.has(pid)) breakdown.rollKylling += count;
        }
      } else if (LEM_IDS.has(pid)) {
        // All lemonade variants counted regardless of price.
        // Refunds (count < 0) subtract automatically.
        lemUnits += count;
        if (LEM_ADDON_IDS.has(pid))      breakdown.lemAddon      += count;
        if (LEM_UPGRADE_IDS.has(pid))    breakdown.lemUpgrade    += count;
        if (LEM_STANDALONE_IDS.has(pid)) breakdown.lemStandalone += count;
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
    PRODUCT_IDS:        PRODUCT_IDS,
    KOMBO_IDS:          KOMBO_IDS,
    KOMBO_LAMB_IDS:     KOMBO_LAMB_IDS,
    KOMBO_FALAFEL_IDS:  KOMBO_FALAFEL_IDS,
    KOMBO_KYLLING_IDS:  KOMBO_KYLLING_IDS,
    ROLL_IDS:           ROLL_IDS,
    ROLL_KEBAB_IDS:     ROLL_KEBAB_IDS,
    ROLL_FALAFEL_IDS:   ROLL_FALAFEL_IDS,
    ROLL_KYLLING_IDS:   ROLL_KYLLING_IDS,
    LEM_IDS:            LEM_IDS,
    LEM_ADDON_IDS:      LEM_ADDON_IDS,
    LEM_UPGRADE_IDS:    LEM_UPGRADE_IDS,
    LEM_STANDALONE_IDS: LEM_STANDALONE_IDS,
    BOWL_IDS:           BOWL_IDS,
    ALL_KNOWN_IDS:      ALL_KNOWN_IDS,
    computeMetrics:     computeMetrics,
  };
}));
