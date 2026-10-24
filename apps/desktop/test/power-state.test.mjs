import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskPowerState} from '../power-state.mjs';
import mac from '../builder.cjs';
import windows from '../builder-win.cjs';

test('task wake lock is idempotent, releases on idle/exit and can restart',()=>{
 const started=[],stopped=[];const power=createTaskPowerState({start:type=>{started.push(type);return started.length;},stop:id=>stopped.push(id)});
 for(const message of [undefined,{}, {type:'dreamatic-power-state',active:'true'},{type:'other',active:true}])power.handle(message);
 assert.deepEqual(started,[]);
 const state=active=>({type:'dreamatic-power-state',active});
 power.handle(state(true));power.handle(state(true));assert.deepEqual(started,['prevent-app-suspension']);
 power.handle(state(false));power.handle(state(false));assert.deepEqual(stopped,[1]);
 power.handle(state(true));power.dispose();power.dispose();power.handle(state(true));assert.deepEqual(stopped,[1,2]);assert.equal(started.length,2);
 for(const config of [mac,windows])assert.ok(config.files.includes('power-state.mjs'));
});
