'use strict';
/**
 * Tests for lib/product-metrics.js — canonical product-metrics engine.
 *
 * Covers:
 *  • Fixture regression       — exact reference values from docs/metric-spec.md
 *  • Staff meal exclusion     — zero-price kombo/roll lines never counted
 *  • Free included roll       — zero-price roll line excluded
 *  • Mixed order              — kombo + separately paid roll in same tx
 *  • Refunds                  — negative count subtracts correctly
 *  • count 2 / count 3        — multi-unit lines contribute correct units
 *  • Bowl exclusion           — bowl IDs never counted as rolls or kombos
 *  • Lemonade forms           — addon, upgrade, standalone all counted
 *  • Unknown ID gating        — misleading product name does NOT classify
 *  • ID-stable classification — known ID still classifies if display name changes
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');

const {
  PRODUCT_IDS, KOMBO_IDS, ROLL_IDS, LEM_IDS, BOWL_IDS, ALL_KNOWN_IDS, computeMetrics,
} = require('../lib/product-metrics');

// ── Convenience line builders ─────────────────────────────────────────────────
// `pid` can be either a PRODUCT_IDS key string or a raw ID string.
function line(productid, count, price, name = 'Test Product') {
  return { productid: String(productid), productname: name, count, price };
}
function komboLamb(count = 1, price = 149) {
  return line(PRODUCT_IDS.KOMBO_LAMB, count, price, 'Kombo - Lamb');
}
function komboFalafel(count = 1, price = 149) {
  return line(PRODUCT_IDS.KOMBO_FALAFEL, count, price, 'Kombo - Falafel');
}
function rollKebab(count = 1, price = 95) {
  return line(PRODUCT_IDS.ROLL_KEBAB, count, price, 'Killer Kebab');
}
function rollFalafel(count = 1, price = 95) {
  return line(PRODUCT_IDS.ROLL_FALAFEL, count, price, 'Killer Falafel');
}
function lemAddon(count = 1, price = 10) {
  return line(PRODUCT_IDS.LEM_ADDON, count, price, '+ Lemonade');
}
function lemUpgrade(count = 1, price = 10) {
  return line(PRODUCT_IDS.LEM_UPGRADE, count, price, '+ Killer Lemonade (+10 kr)');
}
function lemStandalone(count = 1, price = 35) {
  return line(PRODUCT_IDS.LEM_STANDALONE, count, price, 'Killer Lemonade (35 kr)');
}

// ── Fixture ───────────────────────────────────────────────────────────────────
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json');
const fixtureLines = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).lines;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('product-metrics — fixture regression', () => {
  let m;
  test('setup: computeMetrics runs on 466 fixture lines', () => {
    m = computeMetrics(fixtureLines);
  });

  test('kombo units = 66', () => {
    assert.equal(m.komboUnits, 66);
  });

  test('standalone paid roll units = 54', () => {
    assert.equal(m.rollUnits, 54);
  });

  test('kombo % = 55.0000 (to 4 dp)', () => {
    const rounded = Math.round(m.komboPct * 10000) / 10000;
    assert.equal(rounded, 55.0);
  });

  test('lemonade units = 20', () => {
    assert.equal(m.lemUnits, 20);
  });

  test('kombo breakdown: Lamb = 49, Falafel = 17', () => {
    assert.equal(m.breakdown.komboLamb,    49);
    assert.equal(m.breakdown.komboFalafel, 17);
  });

  test('roll breakdown: Kebab = 39, Falafel = 15', () => {
    assert.equal(m.breakdown.rollKebab,   39);
    assert.equal(m.breakdown.rollFalafel, 15);
  });

  test('lemonade breakdown: addon=12, upgrade=3, standalone=5', () => {
    assert.equal(m.breakdown.lemAddon,      12);
    assert.equal(m.breakdown.lemUpgrade,     3);
    assert.equal(m.breakdown.lemStandalone,  5);
  });
});

describe('product-metrics — staff meal exclusion', () => {
  test('zero-price kombo-lamb is not counted', () => {
    const m = computeMetrics([komboLamb(1, 0)]);
    assert.equal(m.komboUnits, 0);
  });

  test('zero-price kombo-falafel is not counted', () => {
    const m = computeMetrics([komboFalafel(1, 0)]);
    assert.equal(m.komboUnits, 0);
  });

  test('zero-price roll-kebab is not counted', () => {
    const m = computeMetrics([rollKebab(1, 0)]);
    assert.equal(m.rollUnits, 0);
  });

  test('zero-price roll-falafel is not counted', () => {
    const m = computeMetrics([rollFalafel(1, 0)]);
    assert.equal(m.rollUnits, 0);
  });

  test('staff meal kombo does not affect komboPct denominator', () => {
    // Only one paid roll — komboPct should be 0% (rolls dominate), not null
    const m = computeMetrics([komboLamb(1, 0), rollKebab(1, 95)]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  1);
    assert.equal(m.komboPct,   0);
  });

  test('komboPct is null when only staff meals present (0/0)', () => {
    const m = computeMetrics([komboLamb(1, 0), rollKebab(1, 0)]);
    assert.equal(m.komboPct, null);
  });
});

describe('product-metrics — free included roll exclusion', () => {
  test('zero-price roll line is excluded (same product ID, price = 0)', () => {
    // Some POS setups log a free roll component inside a combo at price 0.
    // The price > 0 filter must exclude it — otherwise the roll would be
    // double-counted (the kombo header already represents the roll).
    const m = computeMetrics([
      komboLamb(1, 149),   // paid kombo (counts)
      rollKebab(1, 0),     // free included roll (must NOT count)
    ]);
    assert.equal(m.komboUnits, 1);
    assert.equal(m.rollUnits,  0);
    assert.ok(Math.abs(m.komboPct - 100) < 0.0001);
  });
});

describe('product-metrics — mixed order (kombo + standalone roll)', () => {
  test('paid roll in the same order as a kombo counts independently', () => {
    // Rule 6: a standalone paid roll alongside a kombo must still be counted.
    const m = computeMetrics([
      komboLamb(1, 149),   // 1 kombo
      rollKebab(1, 95),    // 1 standalone roll — legitimate paid unit
    ]);
    assert.equal(m.komboUnits, 1);
    assert.equal(m.rollUnits,  1);
    const pct = m.komboPct;
    assert.ok(Math.abs(pct - 50) < 0.0001);
  });

  test('two kombos + one roll: komboPct = 66.67%', () => {
    const m = computeMetrics([
      komboLamb(1, 149),
      komboFalafel(1, 149),
      rollKebab(1, 95),
    ]);
    assert.equal(m.komboUnits, 2);
    assert.equal(m.rollUnits,  1);
    const expected = 2 / 3 * 100;
    assert.ok(Math.abs(m.komboPct - expected) < 0.0001);
  });
});

describe('product-metrics — refunds subtract', () => {
  test('kombo refund (count=-1) subtracts from komboUnits', () => {
    const m = computeMetrics([
      komboLamb(2, 298),    // +2
      komboLamb(-1, -149),  // -1 refund (negative price is still non-zero)
    ]);
    assert.equal(m.komboUnits, 1);
  });

  test('roll refund (count=-1, price=-95) subtracts', () => {
    const m = computeMetrics([
      rollKebab(3, 285),
      rollKebab(-1, -95),
    ]);
    assert.equal(m.rollUnits, 2);
  });

  test('lemonade refund subtracts from lemUnits', () => {
    const m = computeMetrics([
      lemStandalone(2, 70),
      lemStandalone(-1, -35),
    ]);
    assert.equal(m.lemUnits, 1);
  });

  test('refund reduces komboPct denominator accordingly', () => {
    const m = computeMetrics([
      komboLamb(2, 298),
      rollKebab(2, 190),
      komboLamb(-1, -149),  // net: 1 kombo + 2 rolls = 33.33%
    ]);
    assert.equal(m.komboUnits, 1);
    assert.equal(m.rollUnits,  2);
    const expected = 1 / 3 * 100;
    assert.ok(Math.abs(m.komboPct - expected) < 0.0001);
  });

  test('kombo refund (negative price) reduces komboUnits — refunds are not staff meals', () => {
    // Staff meals have price = 0 (excluded).
    // Refunds have price < 0 (included so that signed count subtracts).
    // A refund-only order → komboUnits = -1.
    const m = computeMetrics([komboLamb(-1, -149)]);
    assert.equal(m.komboUnits, -1);
  });
});

describe('product-metrics — count 2 and count 3', () => {
  test('count=2 kombo contributes 2 units', () => {
    const m = computeMetrics([komboLamb(2, 298)]);
    assert.equal(m.komboUnits, 2);
    assert.equal(m.breakdown.komboLamb, 2);
  });

  test('count=3 kombo contributes 3 units', () => {
    const m = computeMetrics([komboLamb(3, 447)]);
    assert.equal(m.komboUnits, 3);
  });

  test('count=2 roll contributes 2 units', () => {
    const m = computeMetrics([rollKebab(2, 190)]);
    assert.equal(m.rollUnits, 2);
    assert.equal(m.breakdown.rollKebab, 2);
  });

  test('count=2 lemonade upgrade contributes 2 units', () => {
    // Fixture has one such line: pid 27242148 count=2 price=20
    const m = computeMetrics([lemUpgrade(2, 20)]);
    assert.equal(m.lemUnits, 2);
    assert.equal(m.breakdown.lemUpgrade, 2);
  });

  test('monetary line total is NOT multiplied by count', () => {
    // price field is already the line total (price per unit × count).
    // This module uses only count for unit metrics; it never touches price×count.
    // Smoke-check: two combos at count=2 → 2 units regardless of price.
    const m = computeMetrics([komboLamb(2, 298)]);
    assert.equal(m.komboUnits, 2);  // NOT 4 (would be wrong if we did count×count)
  });
});

describe('product-metrics — bowl exclusion', () => {
  test('BOWL_IDS set is defined (empty for now — no bowl products in reference data)', () => {
    assert.ok(BOWL_IDS instanceof Set);
  });

  test('synthetic bowl ID is not counted as kombo or roll', () => {
    // Simulate a future bowl product ID added to BOWL_IDS.
    const FAKE_BOWL_ID = '99999999';
    const bowlLine = line(FAKE_BOWL_ID, 1, 95, 'Hummus Bowl');
    // Without adding to BOWL_IDS: the line is simply unknown — not counted.
    const m = computeMetrics([
      komboLamb(1, 149),
      rollKebab(1, 95),
      bowlLine,            // unregistered ID → silently ignored
    ]);
    // kombo and roll counts unaffected by the bowl line
    assert.equal(m.komboUnits, 1);
    assert.equal(m.rollUnits,  1);
  });
});

describe('product-metrics — lemonade forms', () => {
  test('addon lemonade (27242080) counted without price filter', () => {
    const m = computeMetrics([lemAddon(1, 0)]);   // could be free in a comped order
    assert.equal(m.lemUnits, 1);
  });

  test('addon lemonade at non-zero price also counted', () => {
    const m = computeMetrics([lemAddon(1, 10)]);
    assert.equal(m.lemUnits, 1);
  });

  test('upgrade lemonade (27242148) counted without price filter', () => {
    const m = computeMetrics([lemUpgrade(1, 10)]);
    assert.equal(m.lemUnits, 1);
  });

  test('standalone lemonade (27242164) counted', () => {
    const m = computeMetrics([lemStandalone(1, 35)]);
    assert.equal(m.lemUnits, 1);
  });

  test('all three lemonade forms together', () => {
    const m = computeMetrics([lemAddon(1, 10), lemUpgrade(2, 20), lemStandalone(1, 35)]);
    assert.equal(m.lemUnits, 4);  // 1 + 2 + 1
    assert.equal(m.breakdown.lemAddon,      1);
    assert.equal(m.breakdown.lemUpgrade,    2);
    assert.equal(m.breakdown.lemStandalone, 1);
  });

  test('lemonade addon at price=35 still counted (fixture TXN_068 has one)', () => {
    // In the reference fixture, one + Lemonade line has price=35 (unusual pricing).
    // No price filter means it counts regardless.
    const m = computeMetrics([lemAddon(1, 35)]);
    assert.equal(m.lemUnits, 1);
  });

  test('lemonade does not affect komboPct denominator — with one kombo and lemonade', () => {
    // 1 kombo, 0 rolls, 5 lemonades → komboPct = 100% (not null, not 50%)
    const m = computeMetrics([komboLamb(1, 149), lemAddon(5, 10)]);
    assert.equal(m.komboUnits, 1);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   5);
    assert.equal(m.komboPct,   100);  // 1/(1+0)×100 = 100%
  });

  test('lemonade does not affect komboPct denominator — only kombos present', () => {
    const m = computeMetrics([komboLamb(2, 298), lemAddon(5, 10)]);
    assert.equal(m.komboUnits, 2);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.komboPct,   100);  // 2/(2+0)=100%
    assert.equal(m.lemUnits,   5);
  });
});

describe('product-metrics — unknown ID gating', () => {
  test('unknown ID with a misleading "kombo" name is not counted', () => {
    // Rule 11: classification is by product ID only.
    // A product named "Kombo Special" with an unregistered ID must be ignored.
    const m = computeMetrics([
      line('99999001', 1, 149, 'Kombo Special (misleading name)'),
    ]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   0);
  });

  test('unknown ID with "killer" in name is not counted', () => {
    const m = computeMetrics([
      line('99999002', 1, 95, 'Killer Rollover (new product)'),
    ]);
    assert.equal(m.rollUnits, 0);
  });

  test('unknown ID with "lemonade" in name is not counted', () => {
    const m = computeMetrics([
      line('99999003', 1, 35, 'Lemonade Special'),
    ]);
    assert.equal(m.lemUnits, 0);
  });

  test('a known ID still classifies correctly even if its display name changes', () => {
    // If marketing renames "Kombo - Lamb" to "Lamb Wrap Combo", the ID
    // 27242208 must still classify as a kombo.
    const m = computeMetrics([
      line(PRODUCT_IDS.KOMBO_LAMB, 1, 149, 'Lamb Wrap Combo (renamed)'),
    ]);
    assert.equal(m.komboUnits, 1);
  });

  test('known roll ID still classifies if renamed', () => {
    const m = computeMetrics([
      line(PRODUCT_IDS.ROLL_KEBAB, 1, 95, 'Classic Kebab Roll (new name)'),
    ]);
    assert.equal(m.rollUnits, 1);
  });
});

describe('product-metrics — edge cases', () => {
  test('empty lines array → all zeros, komboPct null', () => {
    const m = computeMetrics([]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   0);
    assert.equal(m.komboPct,   null);
  });

  test('null lines → all zeros, komboPct null', () => {
    const m = computeMetrics(null);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.komboPct,   null);
  });

  test('komboPct = 100 when only kombos present', () => {
    const m = computeMetrics([komboLamb(3, 447)]);
    assert.equal(m.komboPct, 100);
  });

  test('komboPct = 0 when only rolls present', () => {
    const m = computeMetrics([rollKebab(2, 190)]);
    assert.equal(m.komboPct, 0);
  });
});

describe('product-metrics — ID registry', () => {
  test('KOMBO_IDS contains both kombo product IDs', () => {
    assert.ok(KOMBO_IDS.has(PRODUCT_IDS.KOMBO_LAMB));
    assert.ok(KOMBO_IDS.has(PRODUCT_IDS.KOMBO_FALAFEL));
    assert.equal(KOMBO_IDS.size, 2);
  });

  test('ROLL_IDS contains both roll product IDs', () => {
    assert.ok(ROLL_IDS.has(PRODUCT_IDS.ROLL_KEBAB));
    assert.ok(ROLL_IDS.has(PRODUCT_IDS.ROLL_FALAFEL));
    assert.equal(ROLL_IDS.size, 2);
  });

  test('LEM_IDS contains all three lemonade product IDs', () => {
    assert.ok(LEM_IDS.has(PRODUCT_IDS.LEM_ADDON));
    assert.ok(LEM_IDS.has(PRODUCT_IDS.LEM_UPGRADE));
    assert.ok(LEM_IDS.has(PRODUCT_IDS.LEM_STANDALONE));
    assert.equal(LEM_IDS.size, 3);
  });

  test('KOMBO_IDS and ROLL_IDS are disjoint', () => {
    for (const id of KOMBO_IDS) assert.ok(!ROLL_IDS.has(id));
  });

  test('all ID sets are disjoint', () => {
    const all = [...KOMBO_IDS, ...ROLL_IDS, ...LEM_IDS, ...BOWL_IDS];
    assert.equal(all.length, new Set(all).size, 'All product IDs must be unique across sets');
  });
});
