import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelResponseTimer} from '../dist/model-response-timer.js';
function fixture(totalMs) {
 let now=0, next=0;const pending=new Map(), failures=[];
 const clock={set(callback,ms){const id=++next;pending.set(id,{callback,at:now+ms});return id;},clear(id){pending.delete(id);}};
 const timer=createModelResponseTimer({firstOutputMs:100,generationMs:200,...(totalMs?{totalMs}:{}),clock,onTimeout:phase=>failures.push(phase)});
 const advance=ms=>{const end=now+ms;while(true){const due=[...pending.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;pending.delete(due[0]);due[1].callback();}now=end;};
 return {timer,advance,failures,pending};
}
const event=type=>({type});
const token=(type='text_delta',delta='text')=>({type:'message_update',assistantMessageEvent:{type,delta}});
const end={type:'message_end',message:{role:'assistant'}};
test('long image tools do not consume response budgets and every following model call gets a fresh allowance',()=>{
 const f=fixture(250);f.timer.handle(event('turn_start'));f.advance(50);f.timer.handle(token('toolcall_start'));f.advance(40);f.timer.handle(end);
 for(let i=0;i<3;i++){
  f.timer.handle(event('tool_execution_start'));f.advance(900000);f.timer.handle(event('tool_execution_end'));
 }
 assert.deepEqual(f.failures,[]);assert.equal(f.pending.size,0);
 f.timer.handle(event('turn_end'));f.timer.handle(event('turn_start'));f.advance(90);f.timer.handle(token());f.advance(100);f.timer.handle(end);
 f.timer.handle(event('agent_end'));f.advance(999999);assert.deepEqual(f.failures,[]);assert.equal(f.pending.size,0);
});
test('first output timeout includes provider wait, but empty events do not count as output',()=>{
 const f=fixture();f.timer.handle(event('turn_start'));f.advance(70);f.timer.handle({type:'message_start',message:{role:'assistant'}});f.timer.handle(token('text_delta',''));f.advance(30);
 assert.deepEqual(f.failures,['first_output']);assert.equal(f.timer.failure,'first_output');assert.equal(f.pending.size,0);
});
test('generation allowance starts on first real output and is not extended by ongoing tokens',()=>{
 for(const type of ['text_delta','thinking_delta','toolcall_start','toolcall_delta']){
  const f=fixture();f.timer.handle(event('turn_start'));f.advance(90);f.timer.handle(token(type));f.advance(199);assert.deepEqual(f.failures,[]);
  f.timer.handle(token());f.advance(1);assert.deepEqual(f.failures,['generation']);
 }
});
test('explicit total cap still limits each model response',()=>{
 const f=fixture(150);f.timer.handle(event('turn_start'));f.advance(90);f.timer.handle(token());f.advance(60);
 assert.deepEqual(f.failures,['total']);assert.equal(f.pending.size,0);
});
test('abort/cleanup and retries cancel timers without late timeout notifications',()=>{
 const f=fixture(150);f.timer.handle(event('turn_start'));f.advance(30);f.timer.dispose();f.advance(1000);assert.deepEqual(f.failures,[]);
 f.timer.handle(event('turn_start'));f.advance(20);f.timer.handle(event('auto_retry_start'));f.advance(1000);assert.deepEqual(f.failures,[]);
 f.timer.handle(event('turn_start'));f.timer.handle(token());f.timer.handle(end);f.timer.handle(event('agent_end'));f.advance(1000);assert.deepEqual(f.failures,[]);
});
