import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCitations} from '../dist/design-citations.js';

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
