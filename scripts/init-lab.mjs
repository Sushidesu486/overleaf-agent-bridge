import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".env")) {
  writeFileSync(
    ".env",
    ["OVERLEAF_SESSION_SECRET", "OVERLEAF_INVITE_TOKEN_SECRET"]
      .map((k) => `${k}=${randomBytes(32).toString("hex")}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}
console.log("Lab environment ready; existing secrets preserved");
