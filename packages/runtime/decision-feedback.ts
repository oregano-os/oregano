/** System feedback is presentation, not a Workflow state or authority receipt. */
const messages = {
  en: {
    delivery: ["Decision saved", "Your decision was saved, but the card could not be updated. Please do not click again."],
    processing: ["Processing your decision…", "Please wait. We are saving your decision."],
    approved: ["Approved — decision recorded", "Your approval was saved. The workflow may now execute the reviewed changes; this is not confirmation that those changes have finished."],
    rejected: ["Rejected — decision recorded", "Your rejection was saved. This decision will not apply the proposed changes."],
    uncertain: ["Decision could not be confirmed", "We could not confirm the result. Please ask an administrator to check the decision before trying again."],
  },
  de: {
    delivery: ["Entscheidung gespeichert", "Deine Entscheidung wurde gespeichert, aber die Nachricht konnte nicht aktualisiert werden. Bitte nicht erneut klicken."],
    processing: ["Entscheidung wird verarbeitet …", "Bitte kurz warten. Deine Entscheidung wird gespeichert."],
    approved: ["Freigabe gespeichert", "Deine Freigabe wurde gespeichert. Die geprüften Änderungen können jetzt ausgeführt werden. Ihr Abschluss wird separat geprüft."],
    rejected: ["Ablehnung gespeichert", "Deine Ablehnung wurde gespeichert. Durch diese Entscheidung werden die vorgeschlagenen Änderungen nicht ausgeführt."],
    uncertain: ["Entscheidung konnte nicht bestätigt werden", "Bitte lass einen Administrator den gespeicherten Stand prüfen, bevor du es erneut versuchst."],
  },
} as const;
export type DecisionFeedback = keyof typeof messages.en;
export function decisionFeedback(status: DecisionFeedback, language?: string) {
  let locale = "en";
  try { locale = new Intl.Locale(language ?? "en").language; } catch { /* Older artifacts may contain a descriptive language name. */ }
  const [title, content] = messages[locale === "de" ? "de" : "en"][status];
  return { title, content };
}
