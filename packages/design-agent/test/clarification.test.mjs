import assert from "node:assert/strict";
import test from "node:test";
import { clarificationFromToolResult } from "../dist/clarification.js";

const question = { id: "intent", header: "意图", question: "为什么设计？", custom: true };
const result = (questions) => ({ content: [{ type: "text", text: JSON.stringify({ status: "waiting_for_user", questions }) }] });

test("shared clarification parser accepts only successful valid result cards", () => {
  assert.equal(clarificationFromToolResult({ ...result([question]), isError: true }, "call"), undefined);
  assert.equal(clarificationFromToolResult(result([question]), "call").id, "call");
  const questions = Array.from({ length: 20 }, (_, index) => ({ ...question, id: `question-${index}` }));
  assert.equal(clarificationFromToolResult(result(questions), "call").questions.length, 20);
  assert.equal(clarificationFromToolResult(result([question, question]), "call"), undefined);
  assert.equal(clarificationFromToolResult({ content: [{ type: "text", text: "invalid JSON" }] }, "call"), undefined);
});
