/** Next awaits this hook before serving any request in a new server process. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.COMPANYOS_ARTIFACT_HASH) {
    const { initializeHostedArtifact } = await import("./lib/artifact.ts");
    await initializeHostedArtifact();
  }
}
