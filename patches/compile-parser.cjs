// Reuse the pinned Overleaf UI's parser, with types erased by its Node runtime.
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { stripTypeScriptTypes } = require("node:module");
const source = readFileSync(
  process.argv[2] ||
    "/overleaf/services/web/frontend/js/ide/log-parser/latex-log-parser.ts",
  "utf8",
);
if (
  createHash("sha256").update(source).digest("hex") !==
  "0919dde9528630b06cf22773d43c40e7a2b2a21311a4fe135f3092c589d00140"
) {
  throw new Error("Unsupported upstream LaTeX log parser");
}
writeFileSync(
  process.argv[3] ||
    "/overleaf/services/web/modules/agent-access/native-latex-log-parser.mjs",
  stripTypeScriptTypes(source),
);
