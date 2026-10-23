import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBuilderTextReadTool,createShowcaseTools,normalizeShowcaseHtml,validateShowcaseHtml,showcaseDirectionMarkdown} from '../dist/showcase.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dreamatic-showcase-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'artifacts'));await writeFile(join(root,'artifacts/hero.png'),png);await writeFile(join(root,'artifacts/detail.png'),png);return root;}
const works=[{id:'hero',role:'hero',section:'Everyday light',purpose:'Introduce the concept'},{id:'detail',role:'detail',section:'Material logic',purpose:'Explain construction'}];
const direction={heroId:'hero',works,markdown:'## Thesis\nWarm domestic light\n## Composition\nA complete hero and material explanation.'};
const allImages='<img src="../artifacts/hero.png" alt="Lamp"><img src="../artifacts/detail.png" alt="Material study">';
test('independent textual curation requires every planned work, without inspection',async t=>{
 const root=await fixture(t),generated={hero:{path:'artifacts/hero.png',digest:'hero'}};let saved;
 const showcase=createShowcaseTools({root,images:[{id:'hero'},{id:'detail'}],generated,saveDirection:async value=>{saved=value}});
 assert.deepEqual(showcase.tools.map(tool=>tool.name),['plan_showcase']);
 const plan=showcase.tools[0], params={heroId:'hero',works,direction:direction.markdown};
 await assert.rejects(plan.execute('plan',params),/all planned/);
 generated.detail={path:'artifacts/detail.png',digest:'detail'};
 await assert.rejects(plan.execute('plan',{...params,works:[works[0]]}),/Every planned work.*detail/);
 await assert.rejects(plan.execute('plan',{...params,works:[...works,works[0]]}),/distinct/);
 await assert.rejects(plan.execute('plan',{...params,works:[...works,{...works[0],id:'unknown'}]}),/Unknown planned/);
 await assert.rejects(plan.execute('plan',{...params,heroId:'unknown'}),/hero/);
 await assert.rejects(plan.execute('plan',{...params,direction:'   '}),/project-specific/);
 await assert.rejects(plan.execute('plan',{...params,works:[works[0],{...works[1],purpose:' '}]}),/purpose/);
 const result=await plan.execute('plan',params);
 assert.equal(showcase.direction,saved);assert.deepEqual(saved.works,works);
 assert.ok(result.content.every(block=>block.type==='text'));
 assert.match(result.content[0].text,/detail: dreamatic-image:detail/);
 assert.match(showcaseDirectionMarkdown(saved),/detail — detail; Material logic; Explain construction/);
 await validateShowcaseHtml(root,`<html><body>${allImages}</body></html>`,saved,generated);
 await assert.rejects(validateShowcaseHtml(root,'<html><img src="../artifacts/hero.png"></html>',saved,generated),/missing.*detail/);
 await assert.rejects(validateShowcaseHtml(root,`<html>${allImages}<img src="https://example.org/fake.png"></html>`,saved,generated),/generated page source/);
 await assert.rejects(validateShowcaseHtml(root,`<html>${allImages}<script>run()</script></html>`,saved,generated),/static page/);
 await rm(join(root,'artifacts/hero.png'));
 await assert.rejects(validateShowcaseHtml(root,`<html>${allImages}</html>`,saved,generated),/ENOENT/);
});
test('hidden, inactive, background-only and tiny image references do not satisfy coverage',async t=>{
 const root=await fixture(t),generated={hero:{path:'artifacts/hero.png'},detail:{path:'artifacts/detail.png'}};
 for(const hidden of [
  '<!-- <img src="../artifacts/detail.png"> -->',
  '<template><img src="../artifacts/detail.png"></template>',
  '<details><img src="../artifacts/detail.png"></details>',
  '<textarea><img src="../artifacts/detail.png"></textarea>',
  '<noscript><img src="../artifacts/detail.png"></noscript>',
  '<figure hidden><img src="../artifacts/detail.png"></figure>',
  '<img src="../artifacts/detail.png" style="display:none">',
  '<figure style="opacity:0"><img src="../artifacts/detail.png"></figure>',
  '<img src="../artifacts/detail.png" width="1">',
  '<img src="../artifacts/detail.png" style="max-height:1px">',
  '<style>.excluded{display:none}</style><figure class="excluded"><img src="../artifacts/detail.png"></figure>',
  '<div style="background-image:url(../artifacts/detail.png)"></div>',
 ]) await assert.rejects(validateShowcaseHtml(root,`<html><body><img src="../artifacts/hero.png">${hidden}</body></html>`,direction,generated),/missing.*detail/,hidden);
 // A real image later in the page counts even when a separate placeholder is hidden.
 await validateShowcaseHtml(root,`<html><body><div hidden><img src="../artifacts/detail.png"></div>${allImages}</body></html>`,direction,generated);
});
test('Builder uses Pi text reading and rejects image files without emitting image blocks',async t=>{
 const root=await fixture(t);await writeFile(join(root,'design.md'),'# Concept\nMaterial logic');
 const read=createBuilderTextReadTool(root);
 const result=await read.execute('read',{path:'design.md'});
 assert.ok(result.content.every(block=>block.type==='text'));assert.match(result.content[0].text,/Material logic/);
 await assert.rejects(read.execute('read',{path:'artifacts/hero.png'}),/text documents only/);
});
test('a failed direction save does not advance the mandatory curation gate',async t=>{
 const root=await fixture(t), generated={hero:{path:'artifacts/hero.png'},detail:{path:'artifacts/detail.png'}};
 const showcase=createShowcaseTools({root,images:works,generated,saveDirection:async()=>{throw new Error('Disk full')}});
 await assert.rejects(showcase.tools[0].execute('plan',{heroId:'hero',works,direction:'Light and material'}),/Disk full/);
 assert.equal(showcase.direction,undefined);
});
test('exhibition normalization removes only a full enclosing HTML fence',()=>{
 const html='<!doctype html><html><head><title>Work</title></head><body>Work</body></html>';
 assert.equal(normalizeShowcaseHtml('```html\n'+html+'\n```'),html);
 assert.equal(normalizeShowcaseHtml(html),html);
 assert.throws(()=>normalizeShowcaseHtml('Here is your page\n'+html),/complete HTML/);
 assert.throws(()=>normalizeShowcaseHtml('<html>Incomplete'),/complete HTML/);
});
