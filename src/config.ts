import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
const schema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  password: z.string().min(1),
  allowedProjectIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).default([]),
});
export type Config = z.infer<typeof schema>;
export async function loadConfig(): Promise<Config> {
  const path = process.env.OVERLEAF_AGENT_CONFIG ?? ".local/client.json";
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0)
    throw new Error("Credential file must have mode 0600");
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}
