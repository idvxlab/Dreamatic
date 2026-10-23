import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {resolveShowcaseImages,validateShowcaseHtml} from '../dist/showcase.js';
import {recoverBuilderDraft,savedShowcaseDirection,showcaseAssets} from '../dist/builder-recovery.js';
const image={id:'preface-opening',introduction:'Opening',size:'1024x1024',prompt:'Opening design'};
const direction={heroId:image.id,works:[{id:image.id,role:'hero',section:'Opening',purpose:'Introduce the work'}],markdown:'A quiet full-view opening.'};
const canonical='../artifacts/preface-opening-783d02139d05.png',typo='../artifacts/preface-opening-783d0213d05.png';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dreamatic-builder-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'artifacts'));const bytes=Buffer.from('an immutable generated image');const generated={[image.id]:{path:canonical.slice(3),digest:createHash('sha256').update(bytes).digest('hex')}};await writeFile(join(root,generated[image.id].path),bytes);return {root,generated};}
test('stable ids bind image/link attributes, while the exact incident is corrected by one hash edit',async t=>{
 const {root,generated}=await fixture(t);
 const raw='<html><body><a href="dreamatic-image:preface-opening"><img src="dreamatic-image:preface-opening"></a><!-- <img src="dreamatic-image:unknown"> --><p>dreamatic-image:preface-opening</p></body></html>';
 const descriptive=await resolveShowcaseImages(root,`<html><img src="dreamatic-image:preface-opening" alt='Example src="dreamatic-image:unknown"'></html>`,direction,generated);
 assert.ok(descriptive.html.includes(`alt='Example src="dreamatic-image:unknown"'`));
 const bound=await resolveShowcaseImages(root,raw,direction,generated);
 assert.equal(bound.repairs.length,0);assert.ok(bound.html.includes(`href="${canonical}"`));assert.ok(bound.html.includes(`src="${canonical}"`));assert.match(bound.html,/<p>dreamatic-image:preface-opening<\/p>/);
 await validateShowcaseHtml(root,bound.html,direction,generated);
 const corrected=await resolveShowcaseImages(root,`<html><img src="${typo}"></html>`,direction,generated);assert.deepEqual(corrected.repairs,[{id:image.id,from:typo,to:canonical}]);
 assert.equal(corrected.html,`<html><img src="${canonical}"></html>`);
});
test('unknown, ambiguous, conflicting, remote and traversal references remain blocked',async t=>{
 const {root,generated}=await fixture(t);
 for(const src of ['dreamatic-image:unknown','https://example.org/'+canonical.slice(3),'../artifacts/../artifacts/preface-opening-783d0213d05.png','../artifacts/preface-openin-783d02139d05.png','../artifacts/preface-opening-000000000000.png','/artifacts/preface-opening-783d0213d05.png'])await assert.rejects(resolveShowcaseImages(root,`<html><img src="${src}"></html>`,direction,generated),/known planned image|Unknown planned image/);
 await assert.rejects(resolveShowcaseImages(root,`<html><img data-image-id="other" src="${canonical}"></html>`,direction,generated),/conflicts/);
 await assert.rejects(resolveShowcaseImages(root,`<html><img src="${canonical}" srcset="https://example.org/image.png 2x"></html>`,direction,generated),/srcset/);
 await assert.rejects(resolveShowcaseImages(root,`<html><img src="${canonical}" src="${typo}"></html>`,direction,generated),/Duplicate/);
 await assert.rejects(resolveShowcaseImages(root,`<html><img src="${canonical}"></html>`,{...direction,works:[...direction.works,{...direction.works[0],id:'alias'}]},{...generated,alias:generated[image.id]}),/Ambiguous/);
 await writeFile(join(root,generated[image.id].path),'altered bytes');await assert.rejects(resolveShowcaseImages(root,'<html></html>',direction,generated),/has changed/);
});
test('paired drafts and directions resume only for matching inputs and unchanged images',async t=>{
 const {root,generated}=await fixture(t),assets=showcaseAssets([image],generated);
 const raw={fingerprint:'current',text:`<html><img src="${typo}"></html>`,direction,assets};
 await writeFile(join(root,'.builder-output.json'),JSON.stringify(raw));await writeFile(join(root,'.showcase-direction.json'),JSON.stringify({fingerprint:'current',direction,assets}));
 assert.deepEqual(await savedShowcaseDirection(root,'current',[image],generated),direction);
 const recovered=await recoverBuilderDraft(root,'current',[image],generated);assert.equal(recovered.repairs.length,1);assert.ok(recovered.html.includes(canonical));
 assert.equal(await recoverBuilderDraft(root,'other',[image],generated),undefined);assert.equal(await savedShowcaseDirection(root,'other',[image],generated),undefined);
 assert.equal(JSON.parse(await readFile(join(root,'.builder-output.json'),'utf8')).text,raw.text);
 await writeFile(join(root,generated[image.id].path),'changed');assert.equal(await recoverBuilderDraft(root,'current',[image],generated),undefined);assert.equal(await savedShowcaseDirection(root,'current',[image],generated),undefined);
});
test('legacy recovery pairs the draft to its own successful plan, without borrowing a later plan',async t=>{
 const {root,generated}=await fixture(t),text=`<html><img src="${typo}"></html>`;
 await writeFile(join(root,'.builder-output.json'),JSON.stringify({fingerprint:'current',text}));await mkdir(join(root,'sessions/builder'),{recursive:true});
 const session={timestamp:'2026-01-01T00:00:03Z',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}};
 await writeFile(join(root,'sessions/builder/one.jsonl'),JSON.stringify(session)+'\n');
 const events=[{at:'2026-01-01T00:00:00Z',type:'agent_started',agent:'builder',invocationId:'first'},{at:'2026-01-01T00:00:01Z',type:'tool_started',toolName:'plan_showcase',toolCallId:'plan',invocationId:'first',input:JSON.stringify({heroId:image.id,works:direction.works,direction:direction.markdown})},{at:'2026-01-01T00:00:02Z',type:'tool_finished',toolName:'plan_showcase',toolCallId:'plan',invocationId:'first',output:JSON.stringify({content:[{type:'text',text:`${image.id}: ${canonical} | hero`}]})},{at:'2026-01-01T00:00:04Z',type:'agent_started',agent:'builder',invocationId:'later'}];
 await writeFile(join(root,'bus.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
 assert.equal((await recoverBuilderDraft(root,'current',[image],generated)).html,`<html><img src="${canonical}"></html>`);
 await writeFile(join(root,'sessions/builder/one.jsonl'),JSON.stringify({...session,message:{...session.message,content:[{type:'text',text:'<html>A different output</html>'}]}})+'\n');
 assert.equal(await recoverBuilderDraft(root,'current',[image],generated),undefined);
});
