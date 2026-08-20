import { loadArtifact } from "../lib/artifact.ts";

export const dynamic = "force-dynamic";

export default function Home() {
  const artifact = loadArtifact();
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>CompanyOS</h1>
      <p>The {artifact.company} Company Instance is running.</p>
      <p>Artifact <code>{artifact.artifactHash}</code></p>
      <p>Operational health is available at <a href="/api/health">/api/health</a>.</p>
    </main>
  );
}
