import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';

class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync('schema.sql','utf8')); }
  prepare(sql) {
    const db = this.db;
    const wrap = args => ({
      bind: (...values) => wrap(values),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({results: db.prepare(sql).all(...args)}),
      run: async () => db.prepare(sql).run(...args),
      execute: () => db.prepare(sql).all(...args),
    });
    return wrap([]);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const result=statements.map(s=>s.execute()); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
const key='a'.repeat(48);
let now=2000000000;
Date.now=()=>now*1000;
let messages=[];
let rejectChat=null;
globalThis.fetch=async (_url,options)=>{
  const body=JSON.parse(options.body);
  messages.push(body);
  if(body.chat_id===rejectChat) return Response.json({ok:false,parameters:{retry_after:120}}, {status:429});
  return Response.json({ok:true});
};
function environment(){ messages=[]; rejectChat=null; now=2000000000; return {DB:new D1(),DEVICE_SECRET:key,TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_CHAT_IDS:'[111,222]'}; }
async function request(env,path,auth=key,method=path==='/status'?'GET':'POST'){
  const jobs=[];
  const response=await worker.fetch(new Request('https://example.test'+path,{method,headers:{Authorization:'Bearer '+auth}}),env,{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);
  return response;
}
const cron=env=>worker.scheduled({},env,{});
const state=env=>env.DB.db.prepare('SELECT * FROM monitor').get();

test('initial Cron is silent; first heartbeat arms monitor',async()=>{
  const env=environment(); await cron(env); assert.equal(messages.length,0);
  await request(env,'/heartbeat'); assert.equal(state(env).status,'up'); assert.equal(messages.length,0);
});
test('threshold, repeated Cron and restoration send only transitions to all recipients',async()=>{
  const env=environment(); await request(env,'/heartbeat');
  now+=119; await cron(env); assert.equal(messages.length,0);
  now++; await cron(env); assert.equal(messages.length,2); assert.equal(state(env).status,'down');
  now+=60; await cron(env); assert.equal(messages.length,2);
  await request(env,'/heartbeat'); assert.equal(messages.length,4); assert.equal(state(env).status,'up');
  await request(env,'/heartbeat'); assert.equal(messages.length,4);
});
test('unauthorized heartbeat cannot change state',async()=>{
  const env=environment(); assert.equal((await request(env,'/heartbeat','wrong')).status,401);
  assert.equal(state(env).status,'unknown');
});
test('failed recipient retries without duplicating successful recipient',async()=>{
  const env=environment(); rejectChat='111'; await request(env,'/test');
  assert.equal(messages.length,2); now+=60; await cron(env); assert.equal(messages.length,2);
  rejectChat=null; now+=60; await cron(env); assert.equal(messages.length,3); assert.equal(messages[2].chat_id,'111');
});
test('concurrent restoration generates only one event and one delivery per chat',async()=>{
  const env=environment(); await request(env,'/heartbeat'); now+=120; await cron(env);
  await Promise.all([request(env,'/heartbeat'),request(env,'/heartbeat')]);
  assert.equal(messages.length,4);
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM events WHERE kind='up'").get().n,1);
});
test('pending outage is delivered before restoration to same chat',async()=>{
  const env=environment(); await request(env,'/heartbeat'); rejectChat='111'; now+=120; await cron(env);
  await request(env,'/heartbeat'); // 222 receives restoration, 111 must still wait.
  const firstCount=messages.filter(x=>x.chat_id==='111').length;
  assert.equal(firstCount,1); rejectChat=null; now+=120; await cron(env); await cron(env);
  const received=messages.filter(x=>x.chat_id==='111');
  assert.match(received[1].text,/^(🌚|🕯️|🔌)/);
  assert.match(received[2].text,/^(💡|⚡|🔋)/);
  assert.doesNotMatch(received[1].text + received[2].text,/Час події|Подія №|без сигналу|UTC/);
});
test('status exposes Cron timestamp only with authentication',async()=>{
  const env=environment(); await cron(env);
  assert.equal((await request(env,'/status','wrong')).status,401);
  const result=await (await request(env,'/status')).json(); assert.equal(result.last_cron,now);
});

test('D1 failures are logged without sending technical messages to Telegram',async()=>{
  const env=environment();
  env.DB.prepare=()=>{throw new Error('D1_ERROR: Network connection lost.');};
  env.DB.batch=async()=>{throw new Error('D1_ERROR: Network connection lost.');};
  assert.equal((await request(env,'/status')).status,500);
  await assert.rejects(cron(env),/Monitor cron failed/);
  assert.equal(messages.length,0);
});
