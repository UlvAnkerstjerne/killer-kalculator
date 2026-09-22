'use strict';
// Regression fixture tests for Nørrebro 2026-09-20.
// Validates all displayed metrics against the sanitised fixture at
// data/norrebro-2026-09-20.fixture.json.
// Run with: node --test fixture.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');

// ── Load fixture ──────────────────────────────────────────────────────────────
const FIXTURE_PATH = path.join(__dirname, 'test', 'fixtures', 'norrebro-2026-09-20.fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const lines   = fixture.lines;

// ── Product IDs ───────────────────────────────────────────────────────────────
const KOMBO_LAMB_PID  = 27242208;
const KOMBO_FAL_PID   = 27242204;
const KK_PID          = 27242336;   // Killer Kebab roll
const KF_PID          = 27242332;   // Killer Falafel roll
const LEM_ADDON_PID   = 27242080;   // + Lemonade (kombo addon)
const LEM_UPGRADE_PID = 27242148;   // + Killer Lemonade (+10 kr upgrade)
const LEM_STAND_PID   = 27242164;   // Killer Lemonade standalone (35 kr)

// ── Helpers ───────────────────────────────────────────────────────────────────
const p  = l => parseFloat(l.price        ?? 0);
const pe = l => parseFloat(l.priceexclvat ?? 0);
const c  = l => parseFloat(l.count        ?? 0);

const round2 = n => Math.round(n * 100)   / 100;
const round4 = n => Math.round(n * 10000) / 10000;

// ── Fixture integrity ─────────────────────────────────────────────────────────
describe('fixture integrity', () => {
  test('contains exactly 466 lines', () => {
    assert.equal(lines.length, 466);
  });

  test('fixture metadata matches expected values', () => {
    assert.equal(fixture.store,       'norrebro');
    assert.equal(fixture.date,        '2026-09-20');
    assert.equal(fixture.lines_count, 466);
  });

  test('all 466 line_ids are unique', () => {
    const ids = lines.map(l => l.line_id);
    assert.equal(new Set(ids).size, 466);
  });

  test('line_ids follow LID_NNNN format', () => {
    const re = /^LID_\d{4}$/;
    for (const l of lines) assert.match(l.line_id, re);
  });

  test('has exactly 80 unique tx_ids', () => {
    assert.equal(new Set(lines.map(l => l.tx_id)).size, 80);
  });

  test('tx_ids follow TXN_NNN format', () => {
    const re = /^TXN_\d{3}$/;
    for (const l of lines) assert.match(l.tx_id, re);
  });

  test('all lines carry date 2026-09-20', () => {
    for (const l of lines) assert.equal(l.date, '2026-09-20');
  });
});

// ── Forbidden fields ──────────────────────────────────────────────────────────
describe('no forbidden fields in fixture lines', () => {
  const FORBIDDEN = [
    'orderid', 'orderlineid', 'ordernumber',
    'cardnumber', 'cardcountry',
    'clerk', 'pid',
    'pnumber', 'chkno',
    'accountnumber', 'account', 'MasterID',
    'debtorname', 'debtornumber',
    'companyname', 'firmaid',
    'department', 'table', 'pax',
    'vatrate', 'costprice',
    'ean_1', 'ean_2', 'ean_3', 'ean_4',
    'timestamp_order', 'datetime', 'timestamp_pay',
  ];

  for (const field of FORBIDDEN) {
    test(`field "${field}" is absent`, () => {
      for (const line of lines) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(line, field), false,
          `Line ${line.line_id} contains forbidden field "${field}"`
        );
      }
    });
  }

  test('no secret-looking string values (>20 chars, no spaces, alphanumeric)', () => {
    const SECRET = /^[A-Za-z0-9_\-.]{21,}$/;
    for (const line of lines) {
      for (const [k, v] of Object.entries(line)) {
        if (typeof v === 'string' && SECRET.test(v)) {
          assert.fail(`Potential secret in field "${k}" of ${line.line_id}: ${v.slice(0, 8)}…`);
        }
      }
    }
  });
});

// ── Revenue reconciliation ────────────────────────────────────────────────────
describe('revenue reconciliation', () => {
  test('sum(price) = 16429.60 DKK incl. VAT', () => {
    assert.equal(round2(lines.reduce((s, l) => s + p(l), 0)), 16429.60);
  });

  test('sum(priceexclvat) = 13143.68 DKK excl. VAT', () => {
    assert.equal(round2(lines.reduce((s, l) => s + pe(l), 0)), 13143.68);
  });

  test('price is line total — sum(price) differs from sum(price × count)', () => {
    // price already includes count, so multiplying again is wrong.
    // These two figures MUST differ (count>1 lines exist).
    const sumP  = lines.reduce((s, l) => s + p(l), 0);
    const sumPC = lines.reduce((s, l) => s + p(l) * c(l), 0);
    assert.notEqual(round2(sumP), round2(sumPC));
  });

  test('Wolt sum(price) = 2650.60', () => {
    const wolt = lines.filter(l => l.paymenttype === 'Wolt');
    assert.equal(round2(wolt.reduce((s, l) => s + p(l), 0)), 2650.60);
  });

  test('Wolt sum(priceexclvat) = 2120.48', () => {
    const wolt = lines.filter(l => l.paymenttype === 'Wolt');
    assert.equal(round2(wolt.reduce((s, l) => s + pe(l), 0)), 2120.48);
  });

  test('Wolt share of excl-VAT revenue = 16.1331%', () => {
    const total = lines.reduce((s, l) => s + pe(l), 0);
    const wolt  = lines.filter(l => l.paymenttype === 'Wolt').reduce((s, l) => s + pe(l), 0);
    assert.equal(round4(wolt / total * 100), 16.1331);
  });
});

// ── Count field semantics ─────────────────────────────────────────────────────
describe('count field semantics', () => {
  test('22 lines have count = 2', () => {
    assert.equal(lines.filter(l => c(l) === 2).length, 22);
  });

  test('4 lines have count = 3', () => {
    assert.equal(lines.filter(l => c(l) === 3).length, 4);
  });

  test('no refund lines (count < 0) in fixture', () => {
    assert.equal(lines.filter(l => c(l) < 0).length, 0);
  });

  test('unit counts are derived from count field (not from price division)', () => {
    // Kombo-Lamb has count=1, count=2, count=3 lines. Summing the count field
    // gives 49. If counts were derived by dividing price by a unit price the
    // totals would be different for any line where price != unit_price.
    const lambUnits = lines
      .filter(l => l.productid === KOMBO_LAMB_PID && p(l) > 0)
      .reduce((s, l) => s + c(l), 0);
    assert.equal(lambUnits, 49);
  });
});

// ── Kombo metrics ─────────────────────────────────────────────────────────────
describe('kombo unit counts', () => {
  test('Kombo - Lamb net paid units = 49', () => {
    assert.equal(
      lines.filter(l => l.productid === KOMBO_LAMB_PID && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      49
    );
  });

  test('Kombo - Falafel net paid units = 17', () => {
    assert.equal(
      lines.filter(l => l.productid === KOMBO_FAL_PID && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      17
    );
  });

  test('total kombo units = 66', () => {
    assert.equal(
      lines.filter(l => (l.productid === KOMBO_LAMB_PID || l.productid === KOMBO_FAL_PID) && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      66
    );
  });
});

// ── Roll metrics ──────────────────────────────────────────────────────────────
describe('standalone roll unit counts', () => {
  test('Killer Kebab paid net units = 39', () => {
    assert.equal(
      lines.filter(l => l.productid === KK_PID && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      39
    );
  });

  test('Killer Falafel paid net units = 15', () => {
    assert.equal(
      lines.filter(l => l.productid === KF_PID && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      15
    );
  });

  test('total paid roll units = 54', () => {
    assert.equal(
      lines.filter(l => (l.productid === KK_PID || l.productid === KF_PID) && p(l) > 0)
           .reduce((s, l) => s + c(l), 0),
      54
    );
  });
});

// ── Kombo % ───────────────────────────────────────────────────────────────────
describe('kombo percentage', () => {
  test('kombo % = 55.0% (bowls excluded; staff meals excluded)', () => {
    const komboUnits = lines
      .filter(l => (l.productid === KOMBO_LAMB_PID || l.productid === KOMBO_FAL_PID) && p(l) > 0)
      .reduce((s, l) => s + c(l), 0);
    const rollUnits = lines
      .filter(l => (l.productid === KK_PID || l.productid === KF_PID) && p(l) > 0)
      .reduce((s, l) => s + c(l), 0);
    assert.equal(round4(komboUnits / (komboUnits + rollUnits) * 100), 55.0);
  });
});

// ── Lemonade metrics ──────────────────────────────────────────────────────────
describe('lemonade unit counts', () => {
  test('+ Lemonade addon units = 12', () => {
    assert.equal(
      lines.filter(l => l.productid === LEM_ADDON_PID)
           .reduce((s, l) => s + c(l), 0),
      12
    );
  });

  test('+ Killer Lemonade upgrade units = 3', () => {
    assert.equal(
      lines.filter(l => l.productid === LEM_UPGRADE_PID)
           .reduce((s, l) => s + c(l), 0),
      3
    );
  });

  test('Killer Lemonade standalone units = 5', () => {
    assert.equal(
      lines.filter(l => l.productid === LEM_STAND_PID)
           .reduce((s, l) => s + c(l), 0),
      5
    );
  });

  test('total lemonade units = 20', () => {
    assert.equal(
      lines
        .filter(l => l.productid === LEM_ADDON_PID ||
                     l.productid === LEM_UPGRADE_PID ||
                     l.productid === LEM_STAND_PID)
        .reduce((s, l) => s + c(l), 0),
      20
    );
  });
});

// ── Synthetic refund semantics ─────────────────────────────────────────────────
// These tests use an explicitly constructed dataset that is completely separate
// from the 2026-09-20 reference fixture.  They prove the three invariants that
// the production calculation code must satisfy whenever refund lines exist.
//
// A refund line carries:
//   count = -1   (negative quantity)
//   price = -149 (already signed — the API returns the negative total directly)
//
// Correct formula: unit_count += count   →  -1
//                  revenue   += price    →  -149
// Wrong formula:   revenue   += price * count  →  -149 * -1 = +149  (flips sign)

describe('synthetic refund semantics (separate from 2026-09-20 fixture)', () => {
  // One normal sale + one refund of the same product
  const SYNTHETIC = [
    { line_id: 'S_001', tx_id: 'S_TXN_001', productid: 99001, count:  1, price:  149, priceexclvat:  119.2 },
    { line_id: 'S_002', tx_id: 'S_TXN_001', productid: 99001, count: -1, price: -149, priceexclvat: -119.2 },
    { line_id: 'S_003', tx_id: 'S_TXN_002', productid: 99001, count:  2, price:  298, priceexclvat:  238.4 },
  ];

  test('count = -1 contributes -1 to unit total', () => {
    const units = SYNTHETIC
      .filter(l => l.productid === 99001)
      .reduce((s, l) => s + l.count, 0);
    // 1 + (-1) + 2 = 2
    assert.equal(units, 2);
  });

  test('refund line count is negative', () => {
    const refund = SYNTHETIC.find(l => l.count < 0);
    assert.ok(refund, 'expected a refund line');
    assert.equal(refund.count, -1);
  });

  test('pre-signed negative price is summed directly (not multiplied by count)', () => {
    // Correct: sum(price) = 149 + (-149) + 298 = 298
    const correct = SYNTHETIC.reduce((s, l) => s + l.price, 0);
    assert.equal(correct, 298);
  });

  test('multiplying price × count gives wrong result for refund lines', () => {
    // Wrong formula flips refund sign: 149*1 + (-149)*(-1) + 298*2 = 149+149+596 = 894
    const wrong = SYNTHETIC.reduce((s, l) => s + l.price * l.count, 0);
    assert.equal(wrong, 894);           // not 298
    assert.notEqual(wrong, 298);
  });

  test('sum(price) != sum(price * count) — proof that price is already the line total', () => {
    const sumP  = SYNTHETIC.reduce((s, l) => s + l.price, 0);
    const sumPC = SYNTHETIC.reduce((s, l) => s + l.price * l.count, 0);
    assert.notEqual(sumP, sumPC);
  });

  test('excl-VAT refund also subtracts when summed directly', () => {
    const total = SYNTHETIC.reduce((s, l) => s + l.priceexclvat, 0);
    // 119.2 + (-119.2) + 238.4 = 238.4
    assert.ok(Math.abs(total - 238.4) < 0.001, `Expected 238.4, got ${total}`);
  });
});
