import { CardText, type CardElement } from "chat";

/** Presentation only: the caller must authenticate the action before editing.
 * Preserve all sections from our original decision card, including exact bound
 * values and links. Unknown layouts fail rather than silently losing content. */
export function retainSlackDecisionReview(raw: unknown, feedback: CardElement): CardElement {
  const message = (raw as { message?: { blocks?: unknown[] } })?.message;
  if (!Array.isArray(message?.blocks) || !message.blocks.length) throw new Error("Original review blocks are unavailable");
  let title: string | undefined;
  const sections: CardElement["children"] = [];
  for (const entry of message.blocks) {
    const block = entry as { type?: string; text?: { type?: string; text?: string } };
    if (block.type === "actions") continue;
    if (block.type === "header" && title === undefined && typeof block.text?.text === "string") {
      title = block.text.text;
    } else if (block.type === "section" && block.text?.type === "mrkdwn" && typeof block.text.text === "string") {
      sections.push(CardText(block.text.text));
    } else throw new Error("Original review contains an unsupported block; preserve the existing message");
  }
  if (!sections.length) throw new Error("Original review content is unavailable");
  return { type: "card", title, children: [...sections, CardText(feedback.title ?? "", { style: "bold" }), ...feedback.children] };
}
