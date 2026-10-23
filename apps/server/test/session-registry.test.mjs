import assert from "node:assert/strict";
import test from "node:test";
import { clarificationFromMessages } from "../dist/session-registry.js";

const requestMessage = {
  role: "assistant",
  content: [{
    type: "toolCall",
    id: "question-call-1",
    name: "ask_user",
    arguments: {
      title: "先确认设计方向",
      questions: [{
        header: "主要用户",
        question: "这款产品主要为谁设计？",
        options: [
          { label: "居家用户", description: "重视陪伴感与安静体验" },
          { label: "共享办公", description: "重视克制反馈与隐私" },
        ],
        multiple: true,
        custom: true,
      }],
    },
  }],
};

const successfulResult = {
  role: "toolResult", toolName: "ask_user", toolCallId: "question-call-1", isError: false,
  content: [{ type: "text", text: JSON.stringify({ status: "waiting_for_user", ...requestMessage.content[0].arguments }) }],
};

test("restores a pending structured clarification from Pi messages", () => {
  assert.deepEqual(clarificationFromMessages([{ role: "user", content: "做一个产品" }, requestMessage, successfulResult]), {
    id: "question-call-1",
    title: "先确认设计方向",
    questions: [{
      id: "question-1",
      header: "主要用户",
      question: "这款产品主要为谁设计？",
      options: [
        { label: "居家用户", description: "重视陪伴感与安静体验" },
        { label: "共享办公", description: "重视克制反馈与隐私" },
      ],
      multiple: true,
      custom: true,
      required: true,
    }],
  });
});

test("clears the pending clarification after the next user answer", () => {
  assert.equal(clarificationFromMessages([requestMessage, successfulResult, { role: "user", content: "居家用户" }]), undefined);
});

test("does not publish unfinished or failed clarification calls", () => {
  assert.equal(clarificationFromMessages([requestMessage]), undefined);
  assert.equal(clarificationFromMessages([requestMessage, { ...successfulResult, isError: true }]), undefined);
  assert.equal(clarificationFromMessages([successfulResult]), undefined);
});

test("failed clarification followed by a valid retry publishes only the retry", () => {
  const failed = { ...successfulResult, isError: true };
  const retry = { role: "assistant", content: [{ ...requestMessage.content[0], id: "retry" }] };
  assert.equal(clarificationFromMessages([requestMessage, failed, retry, { ...successfulResult, toolCallId: "retry" }]).id, "retry");
});

test("restores all questions without a card count ceiling", () => {
  const questions = Array.from({ length: 20 }, (_, index) => ({ ...requestMessage.content[0].arguments.questions[0], id: `question-${index}` }));
  const result = { ...successfulResult, content: [{ type: "text", text: JSON.stringify({ status: "waiting_for_user", questions }) }] };
  assert.equal(clarificationFromMessages([requestMessage, result]).questions.length, 20);
});

test("a later clarification cannot replace unanswered questions", () => {
  const retry = { role: "assistant", content: [{ ...requestMessage.content[0], id: "retry" }] };
  const messages = [requestMessage, successfulResult, retry, { ...successfulResult, toolCallId: "retry" }];
  assert.equal(clarificationFromMessages(messages).id, "question-call-1");
  assert.equal(clarificationFromMessages([...messages, { role: "user", content: "我的回答" }, retry, { ...successfulResult, toolCallId: "retry" }]).id, "retry");
});

test('pending structured questions survive process restart as waiting, not interrupted', async t => {
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {SessionRegistry}=await import('../dist/session-registry.js');
 const root=await mkdtemp(join(tmpdir(),'dreamatic-waiting-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'sessions'),{recursive:true});await mkdir(join(root,'runs/project'),{recursive:true});
 const pending=clarificationFromMessages([requestMessage,successfulResult]);
 await writeFile(join(root,'sessions/registry.json'),JSON.stringify([{id:'session',projectId:'project',title:'Project',createdAt:new Date().toISOString(),running:true,messages:[]} ]));
 await writeFile(join(root,'runs/project/run-state.json'),JSON.stringify({status:'active',stages:{}}));
 await writeFile(join(root,'runs/project/pending-clarification.json'),JSON.stringify(pending));
 const registry=new SessionRegistry(root,root);await registry.initialize();
 assert.equal(registry.view('session').running,false);
 assert.deepEqual(registry.view('session').pendingClarification,pending);
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'waiting_for_user');
 await registry.dispose();
});
