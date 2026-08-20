import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { diagnostic } from "./diagnostics.mjs";
import { inspectWorkspaceOnboarding } from "./onboarding.mjs";

const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");

export function inspectBootstrap(target = process.cwd()) {
  const root = resolve(target);
  if (!existsSync(join(root, "company.md"))) {
    return {
      root,
      summary: {
        state: "needs-workspace",
        verified_scope: null,
        workspace_mode: null,
      },
      diagnostics: [],
      phases: [
        {
          id: "workspace",
          status: "next",
          explanation: "Create one authoring-only Company Workspace from confirmed human answers.",
          next: "Run `companyos create workspace` or use its agent answers-file mode.",
        },
        {
          id: "hosted-repository",
          status: "waiting",
          explanation: "GitHub setup begins only after the local Workspace validates.",
          next: "No hosted action is authorized yet.",
        },
        {
          id: "company-instance",
          status: "waiting",
          explanation: "Runtime hosting, durable state, and messaging are separate operating-Instance work.",
          next: "No Vercel, Neon, or Slack action is authorized by local bootstrap.",
        },
      ],
    };
  }

  const onboarding = inspectWorkspaceOnboarding(root);
  const blocked = hasErrors(onboarding.diagnostics);
  const authoringOnly = onboarding.summary.workspace_mode === "authoring-only";
  const localReady = authoringOnly && onboarding.summary.readiness === "ready-for-hosted-setup" && !blocked;
  return {
    root,
    summary: {
      state: blocked ? "blocked" : localReady ? "locally-verified" : "in-progress",
      verified_scope: localReady ? "authoring-only-local" : null,
      workspace_mode: onboarding.summary.workspace_mode,
      hosted_repository: "unverified",
      company_instance: onboarding.summary.workspace_mode === "authoring-only" ? "not-authorized" : "manual-verification-required",
    },
    diagnostics: onboarding.diagnostics,
    phases: onboarding.checklist.map((item) => ({
      id: item.id,
      status: item.status,
      explanation: item.next,
      next: item.next,
    })),
    onboarding,
  };
}

export function verifyBootstrap(target = process.cwd()) {
  const result = inspectBootstrap(target);
  const diagnostics = [...result.diagnostics];
  if (result.summary.state === "needs-workspace") {
    diagnostics.push(diagnostic("BOOT001", "error", "No Company Workspace exists at the selected path."));
  } else if (result.summary.workspace_mode !== "authoring-only") {
    diagnostics.push(diagnostic("BOOT003", "error", "This bootstrap verifier proves only an authoring-only Workspace. An operating Workspace requires separate Company Instance verification."));
  } else if (result.summary.state !== "locally-verified") {
    diagnostics.push(diagnostic("BOOT002", "error", "Company Workspace bootstrap is not locally ready for hosted setup."));
  }
  return {
    ...result,
    diagnostics,
    verification: {
      ok: !hasErrors(diagnostics),
      scope: "authoring-only-local",
      statement: "Local verification proves the authoring-only Workspace contract. It does not prove a GitHub ruleset, Vercel deployment, Neon database, Slack installation, or operating Company Instance.",
    },
  };
}
