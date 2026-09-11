import { createQualifiedBuilderSnapshot } from "./create-qualified-snapshot.ts";

process.stdout.write(JSON.stringify(await createQualifiedBuilderSnapshot(), null, 2) + "\n");
