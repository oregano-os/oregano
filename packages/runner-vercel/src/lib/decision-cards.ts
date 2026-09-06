import { decisionFeedback, type DecisionFeedback } from "../../../runtime/decision-feedback.ts";
import { Actions, Button, Card, CardText } from "chat";

/** Shared native-card presentation; Tool and workflow decisions keep their own handlers. */
export function decisionCard(args: {
  title: string; content: string; value: string;
  approve: { id: string; label: string }; reject: { id: string; label: string };
}) {
  if (!args.content || args.content.length > 20_000) throw new Error("Decision explanation exceeds the complete-review limit");
  // Each text element stays below Slack's section limit. No content is omitted.
  const sections: string[] = [];
  let remaining = args.content;
  while (remaining.length > 2_500) {
    const boundary = remaining.lastIndexOf("\n", 2_500);
    const end = boundary > 0 ? boundary + 1 : 2_500;
    sections.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  if (remaining) sections.push(remaining);
  return Card({ title: args.title, children: [
    ...sections.map((content) => CardText(content)),
    Actions([
      Button({ id: args.approve.id, label: args.approve.label, style: "primary", value: args.value }),
      Button({ id: args.reject.id, label: args.reject.label, value: args.value }),
    ]),
  ] });
}

/** Feedback never exposes controls or claims completion of downstream effects. */
export function feedbackDecisionCard(status: DecisionFeedback, language?: string) {
  const text = decisionFeedback(status, language);
  return Card({ title: text.title, children: [CardText(text.content)] });
}
export function resolvedDecisionCard(decision: "approved" | "rejected", language?: string) {
  return feedbackDecisionCard(decision, language);
}
