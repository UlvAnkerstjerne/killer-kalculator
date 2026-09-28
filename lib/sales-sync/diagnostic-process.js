'use strict';
// A bounded subprocess boundary for explicit diagnostics, not an importer runner.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const legacy = require('./catalog-diagnostic');
const encoded = require('./catalog-encoded');
const MAX_OUTPUT_BYTES = encoded.MAX_OUTPUT_BYTES;
function validateEnvelope(value) { return value?.format === encoded.FORMAT ? encoded.validateEnvelope(value) : legacy.validateEnvelope(value); }
const SIGNALS = new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGHUP','SIGPIPE','SIGQUIT']);
const MAX_STREAM_BYTES = MAX_OUTPUT_BYTES + 1; // One terminating newline.
function inspectProcessResult({stdout='',stderr='',exitCode=null,signal=null,timedOut=false,outputLimitExceeded=false,spawnFailed=false}) {
  const process = {exitCode:Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255?exitCode:null,
    signal:SIGNALS.has(signal)?signal:signal===null?null:'OTHER',timedOut:timedOut===true,outputLimitExceeded:outputLimitExceeded===true};
  const result = {format:'kk-diagnostic-process-v1',status:'operational-failure',process,failure:null,envelope:null};
  if (typeof stdout!=='string' || typeof stderr!=='string' || Buffer.byteLength(stdout)>MAX_STREAM_BYTES || Buffer.byteLength(stderr)>MAX_STREAM_BYTES) process.outputLimitExceeded=true;
  // Keep a valid envelope even if termination followed it, but never retain
  // partial/malformed output, unknown schemas, duplicate keys or arbitrary text.
  if (!process.outputLimitExceeded && stdout.trim()) {
    try {
      const parsed=JSON.parse(stdout);
      if (JSON.stringify(parsed)+'\n'!==stdout && JSON.stringify(parsed)!==stdout) throw Error();
      validateEnvelope(parsed); result.envelope=parsed;
    } catch { result.failure='INVALID_ENVELOPE'; }
  } else if (!process.outputLimitExceeded) result.failure='NO_ENVELOPE';
  if (process.outputLimitExceeded) result.failure='OUTPUT_LIMIT';
  else if (timedOut) result.failure='TIMEOUT';
  else if (signal!==null) result.failure='SIGNAL';
  else if (spawnFailed || process.exitCode===null) result.failure='PROCESS_FAILURE';
  else if (stderr.length) { result.failure='UNEXPECTED_STDERR'; result.envelope=null; }
  if (!result.failure) result.status=result.envelope.outcome;
  return result;
}
function captureProcess(file,args,{env,cwd,timeoutMs=60000,uid,gid}={}) {
  if (!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1500000) throw Error('INVALID_CONTROLLER_OPTIONS');
  return new Promise(resolve=>{
    let child;
    try { child=spawn(file,args,{cwd,env:env||{},uid,gid,stdio:['ignore','pipe','pipe']}); }
    catch { resolve(inspectProcessResult({spawnFailed:true})); return; }
    const chunks={stdout:[],stderr:[]}, sizes={stdout:0,stderr:0}; let timedOut=false,outputLimitExceeded=false,spawnFailed=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    for(const stream of ['stdout','stderr']) child[stream].on('data',data=>{
      sizes[stream]+=data.length;
      if(sizes[stream]>MAX_STREAM_BYTES) {
        outputLimitExceeded=true; chunks.stdout=[];chunks.stderr=[];child.kill('SIGKILL');
      } else if(!outputLimitExceeded) chunks[stream].push(data);
    });
    child.on('error',()=>{spawnFailed=true;});
    child.on('close',(exitCode,signal)=>{
      clearTimeout(timer);
      let stdout='',stderr='';
      try {
        const decoder=new TextDecoder('utf-8',{fatal:true});
        stdout=decoder.decode(Buffer.concat(chunks.stdout)); stderr=decoder.decode(Buffer.concat(chunks.stderr));
      } catch { stdout='invalid-output'; }
      resolve(inspectProcessResult({stdout,stderr,exitCode,signal,timedOut,outputLimitExceeded,spawnFailed}));
    });
  });
}
async function persistEvidence(file,result) {
  // Reconstruct through the strict parser before a same-directory atomic rename.
  if (!result || result.format!=='kk-diagnostic-process-v1') throw Error('INVALID_CONTROLLER_EVIDENCE');
  const rebuilt=inspectProcessResult({stdout:result.envelope?JSON.stringify(result.envelope)+'\n':'',
    exitCode:result.process.exitCode,signal:result.process.signal,timedOut:result.process.timedOut,
    outputLimitExceeded:result.process.outputLimitExceeded});
  const allowedFailures=new Set([null,'INVALID_ENVELOPE','NO_ENVELOPE','OUTPUT_LIMIT','TIMEOUT','SIGNAL','PROCESS_FAILURE','UNEXPECTED_STDERR']);
  if (!allowedFailures.has(result.failure) || !['operational-failure','structural-review','candidates','completed'].includes(result.status) ||
    Object.keys(result).sort().join()!==['format','status','process','failure','envelope'].sort().join() ||
    Object.keys(result.process).sort().join()!==['exitCode','signal','timedOut','outputLimitExceeded'].sort().join() ||
    JSON.stringify(result.process)!==JSON.stringify(rebuilt.process) ||
    JSON.stringify(result.envelope)!==JSON.stringify(rebuilt.envelope) ||
    (result.failure===null && (rebuilt.failure!==null || result.status!==rebuilt.status)) ||
    (result.failure!==null && result.status!=='operational-failure')) throw Error('INVALID_CONTROLLER_EVIDENCE');
  const safe={format:result.format,status:result.status,process:rebuilt.process,failure:result.failure,envelope:rebuilt.envelope};
  const temp=path.join(path.dirname(file),'.diagnostic-'+randomUUID()+'.tmp'); let handle;
  try {
    handle=await fs.open(temp,'wx',0o600); await handle.writeFile(JSON.stringify(safe)+'\n'); await handle.sync(); await handle.close(); handle=null;
    await fs.rename(temp,file);
    const directory=await fs.open(path.dirname(file),'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { if(handle) await handle.close(); await fs.unlink(temp).catch(()=>{}); }
}
async function runAndRetain(file,args,options,artifact,cleanup=async()=>{}) {
  const result=await captureProcess(file,args,options);
  await persistEvidence(artifact,result); // Never destroy the runtime if retention failed.
  await cleanup();
  return result;
}
module.exports={inspectProcessResult,captureProcess,persistEvidence,runAndRetain,MAX_STREAM_BYTES};
