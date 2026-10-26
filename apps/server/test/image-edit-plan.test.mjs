import test from 'node:test';
import assert from 'node:assert/strict';
import {planImageEdit,editCapabilities,dimensionStatus} from '../dist/image-edit-plan.js';
const source={width:1086,height:1448};
test('explicit UI targets take precedence over conflicting prompt dimensions and unknown capabilities are unverified',()=>{
 const plan=planImageEdit(source,'尺寸维持不变 1086 x 2304','1024x1024',undefined,{});
 assert.deepEqual(plan.targetDimensions,source);assert.equal(plan.conflict,true);assert.equal(plan.requestSize,'1086x1448');assert.equal(plan.capabilitiesKnown,false);
 const custom=planImageEdit(source,'输出1086x2304','1024x1024',undefined,{target:{width:1086,height:2304}});assert.equal(custom.conflict,false);
 assert.equal(dimensionStatus({width:1728,height:2304},source),'same-ratio');
 assert.equal(dimensionStatus({width:862,height:1825},{width:1086,height:2304}),'near-ratio');
 assert.equal(dimensionStatus({width:1024,height:1024},source),'different-ratio');
});
test('edit capability constraints adapt sizes by aspect ratio and bounds',()=>{
 const cap=editCapabilities('{"sizes":["1024x1024","1536x1024","1024x1536"],"step":16}');
 const plan=planImageEdit(source,'背景蓝色','1024x1024',cap,{});assert.equal(plan.adapted,true);assert.equal(plan.requestSize,'1024x1536');
 const bounded=planImageEdit(source,'背景蓝色','1024x1024',{step:16,maxPixels:1_000_000,maxEdge:1024},{});
 const [w,h]=bounded.requestSize.split('x').map(Number);assert.equal(w%16,0);assert.equal(h%16,0);assert.ok(w*h<=1_000_000&&Math.max(w,h)<=1024);
 for(const value of ['{"step":0}','{"sizes":["auto"]}','{"unexpected":true}','{}'])assert.throws(()=>editCapabilities(value));
 assert.throws(()=>planImageEdit(source,'','1024x1024',undefined,{target:{width:999999,height:20}}));
});
