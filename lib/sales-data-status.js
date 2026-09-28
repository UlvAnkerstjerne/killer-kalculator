(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SalesDataStatus=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function rangeLabel(meta) {
    const end = new Date(Date.parse(meta.end) - 86400000).toISOString().slice(0,10);
    return meta.start === end ? meta.start : meta.start + '–' + end;
  }
  function describe(meta) {
    if (!meta || !['database','onlinepos'].includes(meta.source)) return '';
    const warning = meta.metrics?.potentiallyIncomplete?.length ? ' Product classification unresolved: '+meta.metrics.potentiallyIncomplete.join(', ')+'. Revenue includes these products.' : '';
    if (meta.code === 'DB_READ_UNAVAILABLE') return 'Database read failed. No OnlinePOS fallback was attempted. Figures are unavailable; retry after the database issue is resolved.';
    if (meta.source === 'onlinepos') {
      const c = meta.databaseCoverage;
      const stored = c?.days?.filter(d=>d.status==='complete').length || 0;
      const gaps = c?.days?.filter(d=>d.status==='missing').map(d=>d.date) || [];
      let text = 'OnlinePOS for the entire range. '+(meta.complete ? 'Provider traversal complete.' : 'Provider data incomplete or unavailable; figures are unavailable.');
      if (c?.checked) text += ' Stored coverage '+stored+'/'+c.days.length+' days. Missing: '+gaps.slice(0,8).join(', ')+(gaps.length>8?' and '+(gaps.length-8)+' more':'')+'. No stored rows mixed in.';
      else text += meta.routeReason === 'includes-open-day' ? ' Includes Today or a future day; historical storage was not consulted.' : ' Historical storage was not consulted.';
      if (meta.cacheAgeMs !== undefined) text += ' Cached source age: '+Math.floor(meta.cacheAgeMs/60000)+' min.';
      return text + warning;
    }
    const days = meta.coverage?.days || [];
    const unavailable = days.filter(d => d.status !== 'complete');
    if (unavailable.length) return 'Stored sales unavailable for ' + unavailable.slice(0,8).map(d => d.date+' ('+(d.status==='open-day-unsupported'?'today is not yet stored':d.status==='missing'?'not imported':'coverage needs review')+')').join(', ') + (unavailable.length>8?' and '+(unavailable.length-8)+' more days.':'.') + ' Missing days are not zero sales.';
    const verified = days.filter(d=>d.independentlyVerified).length;
    let text = 'Stored snapshot. Observed ' + (meta.freshness?.oldestObservation || 'at an unknown time') + '. ' + verified+'/'+days.length+' days independently verified; remaining days imported once. No live updates.';
    text += warning;
    return text;
  }
  return {describe,rangeLabel};
}));
