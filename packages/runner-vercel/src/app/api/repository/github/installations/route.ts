import { handleGitHubRepositoryOnboarding } from "../../../../../lib/builder/repository-onboarding.ts";

export async function POST(request: Request): Promise<Response> {
  return await handleGitHubRepositoryOnboarding(request);
}
