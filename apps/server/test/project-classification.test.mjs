import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {projectClassification,resolveProjectClassification,inferProjectClassification,PROJECT_CATEGORIES} from '@dreamatic/project-data';
import {saveProjectClassification} from '../dist/project-classification.js';
const metadata=(primary,secondary=[])=>({schemaVersion:1,taxonomyVersion:'dreamatic-design-v1',primary,secondary});
test('new taxonomy validates metadata and reads legacy scopes without treating HTML as a discipline',()=>{
 assert.equal(PROJECT_CATEGORIES.length,8);
 assert.deepEqual(projectClassification(metadata('space',['visual','space','visual'])),metadata('space',['visual']));
 for(const value of [metadata('invented'),metadata('space',['bad']),{...metadata('space'),taxonomyVersion:'future'},null])assert.equal(projectClassification(value),undefined);
 assert.deepEqual(resolveProjectClassification({resolvedScope:{designScopes:[{category:'industrial'},{category:'media_communication'}]}}),metadata('product',['visual']));
 assert.deepEqual(resolveProjectClassification({classification:metadata('brand'),title:'月球基地'}, {classification:metadata('space')}),metadata('brand'));
 assert.equal(resolveProjectClassification({title:'Untitled'}, {presentation:{mode:'html'}}),undefined);
 for(const [title,id] of [['月球资源开发基地设计','space'],['火星永久殖民定居点','space'],['90周年纪念宣传画册','visual'],['澳门社交媒体宣传图','visual'],['古镇品牌形象','brand']])assert.equal(inferProjectClassification(title).primary,id);
});
test('classification publishes only validated candidates, preserves request, and does not regress on checkpoint replay',async t=>{
 const root=await mkdtemp('/tmp/dreamatic-classify-');t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'brief.json');
 await writeFile(path,JSON.stringify({title:'Untitled',brief:'Original request'}));
 assert.equal(await saveProjectClassification(root,'orchestrator',metadata('bad'),'# Unknown'),undefined);
 assert.deepEqual(await saveProjectClassification(root,'orchestrator',metadata('space'),'# Unknown'),metadata('space'));
 assert.deepEqual(await saveProjectClassification(root,'designer',metadata('brand',['visual']),'# Final'),metadata('brand',['visual']));
 assert.equal(await saveProjectClassification(root,'orchestrator',metadata('space'),'# Earlier'),undefined);
 assert.equal(await saveProjectClassification(root,'designer',metadata('brand',['visual']),'# Final'),undefined);
 const brief=JSON.parse(await readFile(path));assert.equal(brief.brief,'Original request');assert.equal(brief.classificationSource,'designer');assert.deepEqual(brief.classification,metadata('brand',['visual']));
});
