import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResearchReferences,prepareDesignCitations,validateCitations} from '../dist/design-citations.js';
const entries='[1] A. Author, "First source," 2025. https://example.org/one\n[2] B. Author, "Second source," 2026. https://example.org/two';
const research='# Research\nEvidence [1, 2].\n\n## References\n'+entries+'\n';

test('new research requires a final consecutive IEEE-style directory and traceable URLs',()=>{
 validateResearchReferences(research);
 validateResearchReferences('# Research\nNo useful evidence was found.\n\n## References\n');
 validateResearchReferences('# Research\n## References\n[1] A. Author, "Source."\n  https://example.org/one\n');
 for(const invalid of [
  '# Research\nhttps://example.org/one',
  research.replace('[2] B.','[3] B.'),
  research.replace('[2] B.','[1] B.'),
  research.replace('https://example.org/two','no URL'),
  research+'\n## Analysis\nExtra text',
  research.replace('## References','### References'),
  '# Research\nhttps://example.org/one\n## References\n',
  research+'\n## References\n',
  '# Research\n## References\n| [1] | Source | https://example.org/one |',
  research.replace('Evidence [1, 2].','Evidence [3].'),
 ]) assert.throws(()=>validateResearchReferences(invalid),undefined,invalid);
});

test('Designer uses fixed research ids and the system appends ALL exact entries',()=>{
 const body='# Work\nConcept [2].\n\n## Image: detail\n### Introduction\nMaterials [1–2].\n### Prompt\nA complete standalone design prompt.\n';
 const result=prepareDesignCitations(body,research);
 assert.equal(result,body.trimEnd()+'\n\n## References\n'+entries+'\n');
 assert.equal(prepareDesignCitations(result,research),result,'normalization is idempotent');
 assert.deepEqual(validateCitations(prepareDesignCitations('# Work\nOriginal concept.',research),research).unusedReferences,[1,2]);
 assert.throws(()=>prepareDesignCitations('# Work\nUnknown [3].',research),/Missing IEEE reference \[3\]/);
});

test('missing or rewritten bibliography is repaired locally without changing design or image prompts',()=>{
 const body='# Work\nDecision [2].\n';
 for(const wrong of [
  '## References\n[2] Invented author. https://wrong.example/source\n',
  '## References\n[1] Wrong entry\n[1] Duplicate\n',
  '## References\nOmitted entries.\n',
 ]) {
  const design=body+wrong+'## Image: detail\n### Prompt\nDo not alter this prompt.\n';
  assert.equal(prepareDesignCitations(design,research),prepareDesignCitations(body+'## Image: detail\n### Prompt\nDo not alter this prompt.\n',research));
 }
});

test('code examples are preserved and historical research retains the old validation behavior',()=>{
 const body='# Work\n```md\n## References\n[99] Code example\n```\nOriginal work.\n';
 assert.ok(prepareDesignCitations(body,research).startsWith(body.trimEnd()));
 const historic='Source: https://example.org/one';
 const design='# Work\nEvidence [7].\n## References\n[7] Author. https://example.org/one\n';
 assert.equal(prepareDesignCitations(design,historic),design);
 assert.throws(()=>prepareDesignCitations('# Work\nMissing [7].',historic),/Missing IEEE/);
 assert.throws(()=>prepareDesignCitations(design,research.replace('[2] B.','[4] B.')),/consecutive/,'malformed authoritative directories cannot silently become legacy');
});

test('traceable uncited bibliography is a warning without modifying the design',()=>{
 const design='# Design\nAn original work.\n## References\n[9] Background source. https://example.org/background\n\n## Image: hero\n### Introduction\nOriginal design.\n### Size\n1024x1024\n### Prompt\nA complete standalone image.\n';
 const copy=design;
 assert.deepEqual(validateCitations(design,'https://example.org/background'),{unusedReferences:[9]});
 assert.equal(design,copy);
 assert.deepEqual(validateCitations('Original work',''),{unusedReferences:[]});
});
test('a warning never hides missing, duplicate or untraceable references',()=>{
 const valid='\n## References\n[9] Background. https://example.org/background';
 assert.throws(()=>validateCitations('Design [1].'+valid,'https://example.org/background'),/Missing IEEE reference \[1\]/);
 assert.throws(()=>validateCitations('Design.'+valid+'\n[9] Duplicate. https://example.org/background','https://example.org/background'),/Duplicate IEEE reference/);
 assert.throws(()=>validateCitations('Design.'+valid,''),/Reference \[9\] must cite a traceable/,'unused entries still need researched URLs');
 assert.throws(()=>validateCitations('Design.\n## References\n[9] Source without URL',''),/traceable/);
});

test('advisory review collects all citation faults without throwing or changing image prompts',async()=>{
 const {reviewDesignCitations,annotateCitationIssues}=await import('../dist/design-citations.js');
 const body='# Work\nUnknown [77]. Reversed [5]–[1]. Invalid [0].\n## Image: detail\n### Prompt\nKeep exactly this prompt.\n';
 const result=reviewDesignCitations(body,research);
 assert.ok(result.issues.some(issue=>issue.includes('[77]')));
 assert.ok(result.issues.some(issue=>issue.includes('range')));
 assert.ok(result.issues.some(issue=>issue.includes('[0]')));
 assert.ok(result.text.startsWith(body.trimEnd()));
 const annotated=annotateCitationIssues(result);
 assert.match(annotated,/## Citation verification\nSome references need verification/);
 assert.ok(annotated.indexOf('## Citation verification')>annotated.indexOf('Keep exactly this prompt.'));
 assert.ok(annotated.indexOf('## Citation verification')<annotated.indexOf('## References'));
 const {plannedImages}=await import('../dist/design-pipeline.js');
 const imageBody='# Work\nConcept [77].\n## Image: hero\n### Introduction\nUnverified evidence [77].\n### Size\n1024x1024\n### Prompt\nExact image prompt.';
 assert.deepEqual(plannedImages(annotateCitationIssues(reviewDesignCitations(imageBody,research))),plannedImages(imageBody));
});

test('research repairs stay deterministic and ambiguous entries remain visible for verification',async()=>{
 const {reviewResearchCitations,reviewDesignCitations}=await import('../dist/design-citations.js');
 const duplicate=research+'[2] B. Author, "Second source," 2026. https://example.org/two\n';
 const repaired=reviewResearchCitations('```markdown\n'+duplicate+'\n```');
 assert.equal(repaired.issues.length,0);
 assert.equal(repaired.repairs.length,2);
 assert.equal(repaired.text,research);
 for(const invalid of [research.replace('[2] B.','[1] B.'),research.replace('[2] B.','[3] B.'),research.replace('https://example.org/two','URL unavailable'),'# Research\nSource: https://example.org/one']) {
  const result=reviewResearchCitations(invalid);
  assert.ok(result.issues.length);
  const design=reviewDesignCitations('# Work\nUnknown [99].',result.text);
  assert.ok(design.issues.length);
  assert.match(design.text,/Unknown \[99\]/);
 }
});

test('legacy citation faults are advisory and oversized ranges cannot stall review',async()=>{
 const {reviewDesignCitations}=await import('../dist/design-citations.js');
 const legacy='# Work\nMissing [8].\n## References\n[1] No URL\n[1] Duplicate https://unknown.example/source';
 const result=reviewDesignCitations(legacy,'No usable research');
 assert.equal(result.text,legacy);
 assert.ok(result.issues.some(issue=>issue.includes('Duplicate')));
 assert.ok(result.issues.some(issue=>issue.includes('[8]')));
 assert.ok(result.issues.some(issue=>issue.includes('traceable')));
 assert.ok(reviewDesignCitations('# Work\n[1]–[9007199254740991]',research).issues.length);
 assert.ok(reviewDesignCitations('# Work\n[999999999999999999999]–[999999999999999999999]',research).issues.length);
});

test('multiline duplicates are removed only when the complete entries match',async()=>{
 const {reviewResearchCitations}=await import('../dist/design-citations.js');
 const first='[1] Same title.\n  https://example.org/one';
 const other='[1] Same title.\n  https://example.org/two';
 const ambiguous=reviewResearchCitations('# Research\n## References\n'+first+'\n'+other+'\n');
 assert.ok(ambiguous.text.includes(first));assert.ok(ambiguous.text.includes(other));
 assert.ok(ambiguous.issues.length);
 const duplicate=reviewResearchCitations('# Research\n## References\n'+first+'\n'+first+'\n');
 assert.equal(duplicate.text.split(first).length-1,1);assert.equal(duplicate.issues.length,0);
});
