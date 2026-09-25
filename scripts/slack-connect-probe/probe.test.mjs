import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProbe} from './api/check.mjs';
const secret='synthetic-operator-key-of-sufficient-length';
function response(){return {setHeader(){},status(v){this.code=v;return this;},json(v){this.body=v;return this;}};}
const env={SLACK_PROBE_SECRET:secret,SLACK_CONNECTOR:'slack/fixture'};
test('unauthorized requests cannot touch the connector',async()=>{let calls=0;const r=response();await createProbe({environment:env,token:async()=>{calls++;}})({method:'POST',headers:{}},r);assert.equal(r.code,404);assert.equal(calls,0);});
test('provider failure identifies the stage and redacts configured secrets',async()=>{const r=response();await createProbe({environment:env,token:async()=>{throw new Error(`token revoked ${secret}`);}})({method:'POST',headers:{authorization:`Bearer ${secret}`}},r);assert.equal(r.body.stage,'connect-token');assert.ok(!JSON.stringify(r.body).includes(secret));assert.equal(r.body.errorDigest.length,64);});
test('probe makes only auth.test and never returns credentials',async()=>{const credential='xoxb-synthetic-private-credential';let count=0;const r=response();await createProbe({environment:env,token:async()=>credential,request:async(url)=>{count++;assert.equal(url,'https://slack.com/api/auth.test');return {status:200,json:async()=>({ok:true,team_id:'T10001',user_id:'U10001',token:credential})};}})({method:'POST',headers:{authorization:`Bearer ${secret}`}},r);assert.equal(count,1);assert.equal(r.body.ok,true);assert.ok(!JSON.stringify(r.body).includes(credential));});
