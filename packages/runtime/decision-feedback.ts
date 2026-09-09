/** System feedback is presentation, not a Workflow state or authority receipt. */
const messages = {
  en: {
    delivery: ["Decision saved", "Your decision was saved, but the card could not be updated. Please do not click again."],
    processing: ["Processing your decision…", "Please wait. We are saving your decision."],
    approved: ["Approved", ""],
    continuation: ["Approved", "Your approval is saved, but I couldn't continue just now. Please don't submit it again; the saved request needs to be checked."],
    execution: ["I couldn't confirm the changes", "I couldn't complete or verify the changes you approved. Please don't submit them again until the result has been checked."],
    rejected: ["Rejected — decision recorded", "Your rejection was saved. This decision will not apply the proposed changes."],
    uncertain: ["Decision could not be confirmed", "We could not confirm the result. Please ask an administrator to check the decision before trying again."],
  },
  de: {
    delivery: ["Entscheidung gespeichert", "Deine Entscheidung wurde gespeichert, aber die Nachricht konnte nicht aktualisiert werden. Bitte nicht erneut klicken."],
    processing: ["Entscheidung wird verarbeitet …", "Bitte kurz warten. Deine Entscheidung wird gespeichert."],
    approved: ["Freigegeben", ""],
    continuation: ["Freigegeben", "Deine Freigabe ist gespeichert, aber ich konnte gerade nicht fortfahren. Bitte nicht erneut absenden; die gespeicherte Anfrage muss geprüft werden."],
    execution: ["Ich konnte die Änderungen nicht bestätigen", "Ich konnte die freigegebenen Änderungen nicht abschließen oder überprüfen. Bitte nicht erneut absenden, bis das Ergebnis geprüft wurde."],
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
