'use strict';
// Killer K-Intelligence statistics primitives (T1-S). Pure, deterministic, dependency-free.
// Explicit exports: several modules define their own MIN_N / MAX_N, so they are namespaced here.
const validate = require('./validate');
const prng = require('./prng');
const normal = require('./normal');
const robust = require('./robust');
const theilSen = require('./theil-sen');
const mannKendall = require('./mann-kendall');
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
  mannKendall: mannKendall.mannKendall,
  benjaminiHochberg: fdr.benjaminiHochberg,
  detectMeanShift: changePoint.detectMeanShift,
  limits: {
    theilSen: { minN: theilSen.MIN_N, maxN: theilSen.MAX_N },
    mannKendall: { minN: mannKendall.MIN_N, maxN: mannKendall.MAX_N },
    changePoint: { minN: changePoint.MIN_N, maxN: changePoint.MAX_N, defaultReps: changePoint.DEFAULT_REPS },
  },
};
