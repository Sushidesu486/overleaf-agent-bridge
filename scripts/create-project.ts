import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { OverleafClient } from "../src/overleaf.js";
const config = await loadConfig();
if (
  config.baseUrl !== "http://127.0.0.1:18080" ||
  !config.email.endsWith("@example.invalid")
)
  throw new Error("This setup script only targets the local lab");
if (config.allowedProjectIds.length)
  console.log("Lab project already configured");
else {
  const client = new OverleafClient(config);
  await client.login();
  const id = await client.createProject("Agent integration lab");
  config.allowedProjectIds = [id];
  await writeFile(
    process.env.OVERLEAF_AGENT_CONFIG ?? ".local/client.json",
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ projectId: id }));
}
