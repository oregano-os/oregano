import { canStartBuilderDevelopment, type BuilderIntakeInput } from "../../../../runtime/builder/turn-intent.ts";
import { classifyBuilderTurn } from "./turn-intent.ts";

/** Synthetic only: no company context, coding job, provider write or user acceptance. */
export const builderIntakeFixtures = () => {
  const request = { role: "user", content: "Build a new capability reply with four short bullets. I want to test it before publishing." };
  const clarification = { role: "assistant", content: "Should the rule also cover equivalent questions? Once this is resolved I will start the build. No build has been submitted yet." };
  const currentBuild = { jobId: "synthetic-completed-build", objective: "Four bullets", sourceConversation: "example:conversation", createdAt: "2026-01-01T00:00:00Z" };
  return [
    { id: "new-request", text: request.content, history: [], currentBuild: null, expected: "new-build" },
    { id: "clarification-explicit-start", text: "Ja, die Regel soll auch für sinngemäße Varianten gelten. Bitte starte jetzt den Build und bereite den interaktiven Test vor.", history: [request, clarification], currentBuild: null, expected: "new-build" },
    { id: "clarification-answer", text: "Yes, include equivalent questions too.", history: [request, clarification], currentBuild: null, expected: "new-build" },
    { id: "screenshot-question", text: "Is this screenshot correct?", history: [request, { role: "assistant", content: "Your build is ready to test." }], currentBuild, expected: "question" },
    { id: "status-question", text: "Has the coding agent started?", history: [request, clarification], currentBuild: null, expected: "question" },
    { id: "consumed-permission", text: "OK, thank you.", history: [request, { role: "assistant", content: "Your build is complete and ready to test." }], currentBuild, expected: "question" },
    { id: "new-build-with-old-result", text: "Start a new build for a weekly summary workflow. Keep the older test open.", history: [{ role: "assistant", content: "Your previous build is ready to test." }], currentBuild, expected: "new-build" },
  ];
};

export async function qualifyBuilderIntake(classify: typeof classifyBuilderTurn = classifyBuilderTurn) {
  const results = [];
  for (const fixture of builderIntakeFixtures()) {
    const input: BuilderIntakeInput = { messageId: fixture.id, currentMessage: fixture.text, currentBuild: fixture.currentBuild,
      recentConversation: [...fixture.history, { role: "user", content: fixture.text }] };
    const result = await classify(input);
    const canBuild = canStartBuilderDevelopment(result.intent, input.messageId);
    results.push({ id: fixture.id, expected: fixture.expected, actual: result.intent.kind, attempts: result.attempts,
      failures: result.failures, executions: result.executions,
      passed: result.intent.kind === fixture.expected && canBuild === (fixture.expected === "new-build") });
  }
  return { passed: results.every(result => result.passed), results, companyDataUsed: false, codingJobsStarted: 0 };
}
