import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILDER_CONFIRMATION_HISTORY_RESPONSE,
  builderConfirmationWasPresented,
  runnerTurnPresentation,
} from "./presentation.ts";

test("a successfully posted Builder confirmation is the sole visible acknowledgement", () => {
  assert.equal(builderConfirmationWasPresented([{
    toolName: "builder_propose_change",
    output: {
      ok: true,
      pendingConfirmation: true,
      operation: "builder.propose_change",
      requestId: "builder-request-1",
    },
  }]), true);
  assert.match(BUILDER_CONFIRMATION_HISTORY_RESPONSE, /confirmation card was posted/);
  assert.deepEqual(runnerTurnPresentation("Redundant generated response", [{
    toolName: "builder_propose_change",
    output: {
      ok: true,
      pendingConfirmation: true,
      operation: "builder.propose_change",
    },
  }]), {
    historyResponse: BUILDER_CONFIRMATION_HISTORY_RESPONSE,
  });
});

test("normal model output remains visible without a successful Builder card", () => {
  assert.equal(builderConfirmationWasPresented([]), false);
  assert.equal(builderConfirmationWasPresented([{
    toolName: "builder_propose_change",
    output: { ok: false, pendingConfirmation: false },
  }]), false);
  assert.equal(builderConfirmationWasPresented([{
    toolName: "another_tool",
    output: { ok: true, pendingConfirmation: true, operation: "builder.propose_change" },
  }]), false);
  assert.deepEqual(runnerTurnPresentation(" Normal response ", []), {
    historyResponse: "Normal response",
    visibleResponse: "Normal response",
  });
});
