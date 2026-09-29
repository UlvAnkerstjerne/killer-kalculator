#!/usr/bin/env node
'use strict';
// Private operator tool, never a web endpoint or scheduled job. No provider module.
const {withImportOwner}=require('../lib/sales-sync/owner');
const {readConfig}=require('../lib/sales-db/config');
const {listZeroDays,retainZeroObservations,reviewZeroDay}=require('../lib/sales-sync/zero-days');
const {fail,safeError}=require('../lib/sales-sync/errors');
async function main(args=process.argv.slice(2),env=process.env,output=x=>console.log(JSON.stringify(x))) {
  try {
    const values={};const allowed=new Set(['--store','--date','--observation-run','--decision','--reviewed-by','--retain-observation']);
    for(let i=0;i<args.length;i++) {
      const flag=args[i];if(Object.hasOwn(values,flag))fail('INVALID_OPTIONS');
      if(flag==='--list')values[flag]=true;
      else if(allowed.has(flag)&&args[i+1]&&!args[i+1].startsWith('--'))values[flag]=args[++i];
      else fail('INVALID_OPTIONS');
    }
    const config=readConfig(env);
    const result=await withImportOwner(config,async s=>{
      if(values['--list']&&Object.keys(values).length===1)return {days:await listZeroDays(s)};
      if(values['--retain-observation']&&Object.keys(values).length===1)return {days:await retainZeroObservations(s,values['--retain-observation'])};
      if(Object.keys(values).length!==5 || ['--store','--date','--observation-run','--decision','--reviewed-by'].some(k=>!values[k]))fail('INVALID_OPTIONS');
      return reviewZeroDay(s,{storeSlug:values['--store'],businessDate:values['--date'],observationRun:values['--observation-run'],decision:values['--decision'],reviewedBy:values['--reviewed-by']});
    });output(result);return 0;
  }catch(e){output({status:'incomplete',code:safeError(e).code});return 1;}
}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={main};
