(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SalesDataStatus=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function rangeLabel(meta) {
    const end = new Date(Date.parse(meta.end) - 86400000).toISOString().slice(0,10);
    return meta.start === end ? meta.start : meta.start + '–' + end;
  }
  function describe(meta) {
    if (!meta || meta.source !== 'database') return '';
    const days = meta.coverage?.days || [];
    const unavailable = days.filter(d => d.status !== 'complete');
    if (unavailable.length) return 'Stored sales unavailable for ' + unavailable.slice(0,8).map(d => d.date+' ('+(d.status==='open-day-unsupported'?'today is not yet stored':d.status==='missing'?'not imported':'coverage needs review')+')').join(', ') + (unavailable.length>8?' and '+(unavailable.length-8)+' more days.':'.') + ' Missing days are not zero sales.';
    const verified = days.filter(d=>d.independentlyVerified).length;
    let text = 'Stored snapshot. Observed ' + (meta.freshness?.oldestObservation || 'at an unknown time') + '. ' + verified+'/'+days.length+' days independently verified; remaining days imported once. No live updates.';
    if (meta.metrics?.potentiallyIncomplete?.length) text += ' Product classification unresolved: '+meta.metrics.potentiallyIncomplete.join(', ')+'. Revenue includes these products.';
    return text;
  }
  return {describe,rangeLabel};
}));
