'use strict';
// Killer K-Intelligence statistics primitives (T1-S / T1-S2). Pure, deterministic, dependency-free.
// Explicit exports: several modules define their own MIN_N / MAX_N, so they are namespaced here.
const validate = require('./validate');
const prng = require('./prng');
const normal = require('./normal');
const robust = require('./robust');
const theilSen = require('./theil-sen');
const mannKendall = require('./mann-kendall');
const hamedRao = require('./hamed-rao-reference');
const trend = require('./trend');
const fdr = require('./fdr');
const changePoint = require('./change-point');

module.exports = {
  StatsError: validate.StatsError,
  createRng: prng.createRng,
  erfc: normal.erfc,
  normalCdf: normal.normalCdf,
  normalSf: normal.normalSf,
  normalPdf: normal.normalPdf,
  twoSidedP: normal.twoSidedP,
  normalQuantile: normal.normalQuantile,
  MAD_SCALE: robust.MAD_SCALE,
  median: robust.median,
  mad: robust.mad,
  isoWeekday: robust.isoWeekday,
  sameWeekdayBaseline: robust.sameWeekdayBaseline,
  robustZ: robust.robustZ,
  theilSen: theilSen.theilSen,
  senSlope: theilSen.senSlope,
  // Plain Mann-Kendall assumes independent observations: do not gate on it. Use trendTest.
  mannKendall: mannKendall.mannKendall,
  // Reference implementation only, `gating:false` on every result.
  hamedRaoReference: hamedRao.hamedRaoReference,
  trendTest: trend.trendTest,
  trendInterval: trend.trendInterval,
  analyzeTrend: trend.analyzeTrend,
  benjaminiHochberg: fdr.benjaminiHochberg,
  detectMeanShift: changePoint.detectMeanShift,
  defaults: {
    trendMethod: trend.DEFAULT_TREND_METHOD,
    changePointPhiFit: changePoint.DEFAULT_PHI_FIT,
  },
  limits: {
    theilSen: { minN: theilSen.MIN_N, maxN: theilSen.MAX_N },
    mannKendall: { minN: mannKendall.MIN_N, maxN: mannKendall.MAX_N },
    trend: { minN: trend.MIN_N, maxN: trend.MAX_N, defaultReps: trend.DEFAULT_REPS },
    changePoint: { minN: changePoint.MIN_N, maxN: changePoint.MAX_N, defaultReps: changePoint.DEFAULT_REPS },
  },
};
