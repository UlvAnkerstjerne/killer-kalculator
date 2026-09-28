'use strict';
// Explicit reviewed IDs only. Names never drive runtime classification.
const review = require('../catalogues/onlinepos-unresolved-metrics.json');
const unresolved = review.products;
const catalogueReviewCurrent = require('node:crypto').createHash('sha256').update(
  require('node:fs').readFileSync(require('node:path').join(__dirname,'../catalogues/onlinepos-reviewed.json'))
).digest('hex') === review.reviewedCatalogueSha256;
function metricCoverage(lines, storeSlug) {
  const issues = unresolved.filter(p => p.storeSlug === storeSlug).map(p => {
    const affected = lines.filter(l => String(l.productid) === p.productId);
    return { productId:p.productId, reason:p.reason, lineCount:affected.reduce((n,l)=>n+(l.sourceLineCount ?? 1),0),
      quantity:affected.reduce((n,l)=>n+l.count,0), revenueExcl:affected.reduce((n,l)=>n+l.priceexclvat,0) };
  }).filter(p => p.lineCount);
  return { productCountsComplete:catalogueReviewCurrent && issues.length===0, catalogueReviewCurrent, unresolved:issues,
    potentiallyIncomplete:!catalogueReviewCurrent || issues.some(p=>p.reason==='external-placeholder') ? ['rolls','combos','combo-percent','protein-breakdown','lemonade'] : issues.length ? ['lemonade'] : [],
    revenueIncludesUnclassified:true, channelRulesUnchanged:true };
}
module.exports = { metricCoverage };
