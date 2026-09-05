import { validateWorkflowAuthoring } from "../../companyos-builder/workflow-authoring.ts";
import { diagnostic } from "./diagnostics.mjs";

export function inspectWorkflowSteps(root) {
  try {
    return validateWorkflowAuthoring(root).map((message) => {
      const separator = message.indexOf(": ");
      return diagnostic("WF001", "error", separator < 0 ? message : message.slice(separator + 2),
        separator < 0 ? {} : { file: message.slice(0, separator) });
    });
  } catch (error) {
    return [diagnostic("WF002", "error", `Workflow authoring failed validation: ${error.message}`)];
  }
}
