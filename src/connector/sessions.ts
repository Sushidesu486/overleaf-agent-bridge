import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const recordSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  bindingVersion: z.number().int().nonnegative(),
  fingerprint: z.string(),
  nativeSessionId: z.string().min(1).max(1024),
  prompted: z.boolean(),
});
export type NativeSessionRecord = z.infer<typeof recordSchema>;
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Only IDs created by this connector are eligible for resume. Native transcripts
// and credentials stay in their existing stores; this index contains neither.
export class NativeSessionStore {
  constructor(readonly directory: string) {}
  private path(sessionId: string) {
    return join(this.directory, fingerprint(sessionId) + ".json");
  }
  async read(sessionId: string): Promise<NativeSessionRecord | undefined> {
    let text: string;
    try {
      text = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("无法读取本机会话索引，请检查连接配置目录的访问权限");
    }
    try {
      return recordSchema.parse(JSON.parse(text));
    } catch {
      // An incomplete/old index cannot identify a session reliably. The caller
      // rebuilds from the server transcript and reports that recovery mode.
      return;
    }
  }
  async write(sessionId: string, record: NativeSessionRecord) {
    const destination = this.path(sessionId);
    const temporary =
      destination + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(record) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
    } catch {
      throw new Error("无法保存本机会话索引，请检查连接配置目录的访问权限");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
