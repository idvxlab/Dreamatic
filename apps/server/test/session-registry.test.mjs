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

test("restores a pending structured clarification from Pi messages", () => {
  assert.deepEqual(clarificationFromMessages([{ role: "user", content: "做一个产品" }, requestMessage]), {
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
  assert.equal(clarificationFromMessages([requestMessage, { role: "user", content: "居家用户" }]), undefined);
});
