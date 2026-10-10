import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stopAfterCommittedTurn } from "../dist/session-status.js";

const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const corePackage = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
const coreMetadata = sdkRequire(corePackage);
const { Agent } = await import(new URL(coreMetadata.exports["."].import, pathToFileURL(corePackage)).href);

test("Pi ends a committed mixed tool batch without aborting or another provider call", async () => {
  let calls = 0;
  let committed = false;
  const message = {
    role: "assistant", api: "openai-completions", provider: "mock", model: "mock",
    content: [
      { type: "toolCall", id: "progress", name: "progress", arguments: {} },
      { type: "toolCall", id: "commit", name: "commit", arguments: {} },
    ],
    stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const tool = (name) => ({
    name, label: name, description: name, parameters: { type: "object", properties: {} },
    execute: async () => {
      if (name === "commit") committed = true;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  const agent = new Agent({
    initialState: { model: { id: "mock", provider: "mock", api: "openai-completions" }, tools: [tool("progress"), tool("commit")] },
    streamFn: () => {
      calls += 1;
      assert.equal(calls, 1);
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message }; },
        result: async () => message,
      };
    },
  });
  const restore = stopAfterCommittedTurn(agent, () => committed);
  try {
    await agent.prompt("Complete the workflow");
    assert.equal(calls, 1);
    assert.equal(agent.state.messages.at(-1).toolName, "commit");
    assert.equal(agent.state.messages.some((entry) => ["error", "aborted"].includes(entry.stopReason)), false);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    restore();
  }
  assert.equal(agent.shouldStopAfterTurn, undefined);
});

test("committed-turn stop preserves and restores existing SDK stop policy", async () => {
  let calls = 0;
  const previous = async () => { calls += 1; return true; };
  const agent = { shouldStopAfterTurn: previous };
  const restore = stopAfterCommittedTurn(agent, () => false);
  assert.equal(await agent.shouldStopAfterTurn({}), true);
  assert.equal(calls, 1);
  restore();
  assert.equal(agent.shouldStopAfterTurn, previous);
});

test("Pi reports invalid role Context arguments at execution_end before execute and stops unchanged retries", async () => {
  const { roleContextSchema, contextFailureIdentity } = await import('../dist/context-tools.js');
  let executed = 0, calls = 0, failures = 0;
  const keys = new Map();
  const tool = {name:'save_design_context',label:'Save',description:'Save',parameters:{type:'object',properties:{expectedSha256:{type:'null'},data:roleContextSchema('reviewer')},required:['expectedSha256','data'],additionalProperties:false},execute:async()=>{executed++;return {content:[],details:{}};}};
  const agent = new Agent({initialState:{model:{id:'mock',provider:'mock',api:'openai-completions'},tools:[tool]},streamFn:()=>{
    calls++;
    assert.ok(calls<=3);
    const message={role:'assistant',api:'openai-completions',provider:'mock',model:'mock',content:[{type:'toolCall',id:`bad-${calls}`,name:tool.name,arguments:{expectedSha256:null,data:{assessment:{scores:{}},verdict:'pass'}}}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    return {async *[Symbol.asyncIterator](){yield {type:'done',reason:'toolUse',message};},result:async()=>message};
  }});
  agent.subscribe(event=>{
    if(event.type==='tool_execution_end' && event.isError){
      failures++;
      const issue=event.result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
      const key=contextFailureIdentity(event.toolName,issue,event.args).key;
      keys.set(key,(keys.get(key)??0)+1);
    }
  });
  const restore=stopAfterCommittedTurn(agent,()=>[...keys.values()].some(n=>n>=3));
  try{await agent.prompt('Save review');assert.equal(failures,3);assert.equal(calls,3);assert.equal(executed,0);}finally{restore();}
});

test('Context failure fingerprints ignore unrelated edits and recognize actual field repairs', async () => {
  const {contextFailureIdentity:f}=await import('../dist/context-tools.js');
  const issue='context/review.json#/assessment/review_stage must be design_context';
  const key=input=>f('save_design_context',issue,{data:input}).key;
  assert.equal(key({assessment:{review_stage:'artifact',summary:'one'}}),key({assessment:{summary:'two',review_stage:'artifact'}}));
  assert.notEqual(key({assessment:{review_stage:'artifact'}}),key({assessment:{review_stage:'design_context'}}));
});

test('real Pi executes partial Context updates and final commit without regenerating the document',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {createDreamaticExtension}=await import('../dist/extension.js');
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-pi-context-draft-'));
 const tools=new Map();
 const register=parentInvocation=>createDreamaticExtension({workspaceDir:workspace,...(parentInvocation?{parentInvocation}:{})})({registerTool:tool=>tools.set(tool.name,tool),on:()=>{}});
 try {
  register();
  await tools.get('run_init').execute('init',{runIdOverride:'demo',projectTitle:'Research',brief:'Research a page',designScopes:[{id:'ui',category:'ux',task:'Page'}]});
  tools.clear();register({id:'researcher',agent:'researcher',runId:'demo'});
  let calls=0,last,committed=false;
  const agent=new Agent({initialState:{model:{id:'mock',provider:'mock',api:'openai-completions'},tools:['update_design_context','commit_design_context'].map(name=>tools.get(name))},streamFn:()=>{
   calls++;
   assert.ok(calls<=4);
   const name=calls%2?'update_design_context':'commit_design_context';
   const args=calls===1?{changes:{evidence:{target:'Research page',summary:'Complete research'},findings:'Useful findings'}}:
    calls===3?{changes:{usageConditions:'No restricted materials.'}}:{};
   const message={role:'assistant',api:'openai-completions',provider:'mock',model:'mock',content:[{type:'toolCall',id:`draft-${calls}`,name,arguments:args}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   return {async *[Symbol.asyncIterator](){yield {type:'done',reason:'toolUse',message};},result:async()=>message};
  }});
  agent.subscribe(event=>{
   if(event.type!=='tool_execution_end')return;
   assert.equal(event.isError,false);
   last=JSON.parse(event.result.content[0].text);
   if(event.toolName==='commit_design_context') {
    if(calls===2){assert.equal(last.ok,false);assert.ok(last.issues.some(issue=>issue.pointer.startsWith('/usageConditions')));}
    else committed=last.ok===true;
   }
  });
  const restore=stopAfterCommittedTurn(agent,()=>committed);
  try {await agent.prompt('Assemble research Context and repair only missing fields');}finally{restore();}
  assert.equal(calls,4);
  const saved=JSON.parse(await readFile(join(workspace,'runs/demo/context/research.json'),'utf8'));
  assert.equal(saved.findings,'Useful findings');
  assert.equal(saved.revision,1);
  const bus=await readFile(join(workspace,'runs/demo/bus.jsonl'),'utf8');
  assert.equal(bus.includes('research_done'),false);
 }finally{await rm(workspace,{recursive:true,force:true});}
});


test('real Pi batches named updates without manual hashes and preserves nested review evidence',async()=>{
 const {Type}=await import('typebox');
 const {roleContextChangesSchema,prepareContextChanges}=await import('../dist/context-tools.js');
 let calls=0,finished=false;const received=[];
 const detail={id:'issue',evidence:['Source'],verification:'Verify source'};
 const tool={name:'update_design_context',label:'Update',description:'Named content',parameters:Type.Object({changes:roleContextChangesSchema('reviewer')},{additionalProperties:false}),prepareArguments:args=>prepareContextChanges(args,'reviewer'),execute:async(_id,args)=>{received.push(args.changes);finished=received.length===2;return{content:[],details:{}};}};
 const agent=new Agent({initialState:{model:{id:'mock',provider:'mock',api:'openai-completions'},tools:[tool]},streamFn:()=>{
  calls++;assert.equal(calls,1);
  const message={role:'assistant',api:'openai-completions',provider:'mock',model:'mock',content:[{type:'toolCall',id:'summary',name:tool.name,arguments:{changes:{assessment:{summary:'Summary'}}}},{type:'toolCall',id:'evidence',name:tool.name,arguments:{changes:{assessment:{issues:[detail],resolved_issue_ids:[],remaining_risks:[]}}}}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  return{async *[Symbol.asyncIterator](){yield{type:'done',reason:'toolUse',message};},result:async()=>message};
 }});
 const restore=stopAfterCommittedTurn(agent,()=>finished);
 try{await agent.prompt('Write review');assert.equal(calls,1);assert.deepEqual(received[1].assessment.issues,[detail]);}finally{restore();}
});


test('real Pi length stop rejects partial tool calls and Dreamatic stops before an unbounded implicit retry', async () => {
  let requests = 0, executions = 0;
  const message = { role: 'assistant', api: 'openai-completions', provider: 'mock', model: 'mock', stopReason: 'length', timestamp: Date.now(), content: [{ type: 'toolCall', id: 'partial', name: 'save_partial', arguments: { changes: { incomplete: true } } }], usage: { input: 0, output: 16384, cacheRead: 0, cacheWrite: 0, totalTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const { Type } = await import('typebox');
  const { dreamaticSessionFailure } = await import('../dist/session-status.js');
  const agent = new Agent({ initialState: { model: { id: 'mock', provider: 'mock', api: 'openai-completions' }, tools: [{ name: 'save_partial', label: 'Partial', description: 'Must not execute', parameters: Type.Object({ changes: Type.Unknown() }), async execute() { executions++; throw new Error('Truncated tool executed'); } }] }, streamFn: () => {
    requests++; assert.equal(requests, 1);
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'length', message }; }, result: async () => message };
  } });
  const restore = stopAfterCommittedTurn(agent, () => false);
  try { await agent.prompt('Simulate a truncated design update'); } finally { restore(); }
  assert.equal(executions, 0); assert.equal(requests, 1);
  assert.match(dreamaticSessionFailure(agent.state.messages), /token limit/);
});

test('native Pi prepares misplaced role roots before schema validation without losing design values', async () => {
 const {Type}=await import('typebox');
 const {roleContextChangesSchema,prepareContextChanges}=await import('../dist/context-tools.js');
 let received, requests=0;
 const input={changes:{system:{system_thesis:'Original',palette:{},typography:{}}},strategy:{design_intent:'Original intent'},deliverables:[{id:'original',execution:{method:'image_generate',prompt_seed:'Preserved original prompt'}}]};
 const tool={name:'update_design_context',label:'Update',description:'Canonical named content',parameters:Type.Object({changes:roleContextChangesSchema('designer',2)},{additionalProperties:false}),prepareArguments:a=>prepareContextChanges(a,'designer',2),execute:async(_id,a)=>{received=a;return{content:[{type:'text',text:'Saved draft only'}],details:{}};}};
 const message={role:'assistant',api:'openai-completions',provider:'mock',model:'mock',content:[{type:'toolCall',id:'repair-envelope',name:tool.name,arguments:input}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 const agent=new Agent({initialState:{model:{id:'mock',provider:'mock',api:'openai-completions'},tools:[tool]},streamFn:()=>{requests++;assert.equal(requests,1);return{async *[Symbol.asyncIterator](){yield{type:'done',reason:'toolUse',message};},result:async()=>message};}});
 const restore=stopAfterCommittedTurn(agent,()=>Boolean(received));
 try {await agent.prompt('Replay malformed envelope');assert.deepEqual(received.changes,{...input.changes,strategy:input.strategy,deliverables:input.deliverables});assert.equal(agent.state.messages.find(m=>m.role==='toolResult').isError,false);}finally{restore();}
});
