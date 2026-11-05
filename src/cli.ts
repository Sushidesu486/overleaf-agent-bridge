import { loadConfig } from "./config.js";
import { OverleafClient } from "./overleaf.js";
const client = new OverleafClient(await loadConfig());
try {
  const status = await client.status();
  await client.login();
  console.log(
    JSON.stringify(
      { ...status, authenticated: true, projects: await client.listProjects() },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Diagnosis failed");
  process.exitCode = 1;
}
