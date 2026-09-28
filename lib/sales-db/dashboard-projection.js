'use strict';
const {units,amount}=require('../sales-sync/checksums');
const {metricCoverage}=require('../sales-metric-coverage');
const MAX_FACTS=1000000,MAX_GROUPS=100000,MAX_BYTES=32*1024*1024;
const sign=n=>n>0n?1:n<0n?-1:0;
function fail(code){const e=new Error(code);e.code=code;throw e;}
function aggregateNumber(value){
  const number=Number(amount(value));
  if(!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER)fail('DB_NUMERIC_UNREPRESENTABLE');
  // Source values are checked individually by publicLine. Summing their exact
  // decimals can require more digits than Number; allow only sub-display JSON
  // rounding, after exact daily reconciliation, never rounding inside storage.
  const difference=units(number.toFixed(18))-value;
  if(difference>100000000000n||difference< -100000000000n)fail('DB_NUMERIC_UNREPRESENTABLE');
  return number;
}

// Dashboard projection is explicit: hour/product/payment aggregates retain every
// displayed metric. Revenue comparisons instead retain exact boundary seconds.
// A cursor bounds private row memory; all facts are validated in one snapshot.
async function projectSnapshot(session,{id,storeSlug,start,end,states,meta,projection,boundary,publicLine}){
  if(!['dashboard','revenue'].includes(projection))fail('DB_INVALID_PROJECTION');
  if(states.reduce((n,s)=>n+s.lineCount,0)>MAX_FACTS)fail('DB_RANGE_TOO_LARGE');
  const sums=new Map(states.map(s=>[s.date,{count:0,incl:0n,excl:0n}])),groups=new Map(),daily=new Map(),products=new Map();
  let count=0;
  await session.query(`DECLARE dashboard_facts NO SCROLL CURSOR FOR SELECT business_date::text AS date,
    to_char(sale_local,'YYYY-MM-DD HH24:MI:SS') AS "saleLocal",second_of_day AS "secondOfDay",time_quality AS "timeQuality",
    product_id AS "productId",product_label AS "productLabel",group_id AS "groupId",group_label AS "groupLabel",
    quantity::text,revenue_incl::text AS "revenueIncl",revenue_excl::text AS "revenueExcl",
    payment_type AS "paymentType",payment_code AS "paymentCode",reconciliation_state AS state
    FROM sales_foundation.sales_line WHERE store_id=$1 AND business_date >=$2 AND business_date <$3`,[id,start,end]);
  try{while(true){
    const {rows}=await session.query('FETCH FORWARD 500 FROM dashboard_facts');if(!rows.length)break;
    for(const row of rows){
      if(++count>MAX_FACTS||row.state!=='active'||!sums.has(row.date))fail('DB_FACTS_NOT_READY');
      const line=publicLine(row,id),incl=units(row.revenueIncl),excl=units(row.revenueExcl),qty=units(row.quantity),sum=sums.get(row.date);
      sum.count++;sum.incl+=incl;sum.excl+=excl;
      if(projection==='revenue'){
        if(!products.has(line.productid))products.set(line.productid,{quantity:0n,revenue:0n,count:0});
        const product=products.get(line.productid);product.quantity+=qty;product.revenue+=excl;product.count++;
        if(!daily.has(row.date))daily.set(row.date,{revenue:0n,seconds:new Map(),missingTimeLineCount:0});
        const day=daily.get(row.date);day.revenue+=excl;
        if(row.date===boundary){if(row.secondOfDay===null)day.missingTimeLineCount++;else day.seconds.set(row.secondOfDay,(day.seconds.get(row.secondOfDay)||0n)+excl);}
      }else{
        const key=JSON.stringify([line.date,line.hour,line.productid,line.productname,line.productgroupid,line.productgroup,line.paymenttype,line.paymenttypecode,sign(incl),sign(excl),sign(qty)]);
        if(!groups.has(key)){if(groups.size>=MAX_GROUPS)fail('DB_RANGE_TOO_LARGE');groups.set(key,{line:{...line,secondOfDay:null},incl:0n,excl:0n,qty:0n,top:0n,count:0});}
        const group=groups.get(key);group.incl+=incl;group.excl+=excl;group.qty+=qty;group.top+=qty===0n?units('1'):qty;group.count++;
      }
    }
  }}finally{await session.query('CLOSE dashboard_facts');}
  for(const state of states){const sum=sums.get(state.date);if(sum.count!==state.lineCount||sum.incl!==units(state.revenueIncl)||sum.excl!==units(state.revenueExcl))fail('DB_TOTALS_MISMATCH');}
  meta={...meta,rawLineCount:count,processedLineCount:count,projection};
  if(projection==='revenue'){
    meta.metrics=metricCoverage([...products].map(([productid,p])=>({productid,count:aggregateNumber(p.quantity),priceexclvat:aggregateNumber(p.revenue),sourceLineCount:p.count})),storeSlug);
    const days=[...daily].sort(([a],[b])=>a.localeCompare(b));
    const summary={completeRevenue:aggregateNumber(days.reduce((n,[,d])=>n+d.revenue,0n)),daily:days.map(([date,d])=>({date,revenue:aggregateNumber(d.revenue),seconds:[...d.seconds].sort(([a],[b])=>a-b).map(([second,n])=>[second,aggregateNumber(n)]),missingTimeLineCount:d.missingTimeLineCount}))};
    return {lines:[],summary,meta};
  }
  const lines=[...groups.values()].map(g=>({...g.line,count:aggregateNumber(g.qty),price:aggregateNumber(g.incl),priceexclvat:aggregateNumber(g.excl),sourceLineCount:g.count,topItemCount:aggregateNumber(g.top)}));
  lines.sort((a,b)=>a.date.localeCompare(b.date)||(a.hour??24)-(b.hour??24)||a.productid.localeCompare(b.productid)||a.paymenttype.localeCompare(b.paymenttype)||a.price-b.price);
  if(Buffer.byteLength(JSON.stringify(lines))>MAX_BYTES)fail('DB_RANGE_TOO_LARGE');
  return {lines,meta:{...meta,metrics:metricCoverage(lines,storeSlug)}};
}
module.exports={projectSnapshot,MAX_FACTS};
