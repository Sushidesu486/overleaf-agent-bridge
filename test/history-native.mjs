// Run against the built lab image:
// docker compose exec -T overleaf node --input-type=module < test/history-native.mjs
import assert from "node:assert/strict";
import { compressDiff } from "/overleaf/services/project-history/app/js/DiffGenerator.js";

for (const operation of ["i", "d"]) {
  const part = (text, agent) => ({
    [operation]: text,
    meta: {
      users: ["same-human-id"],
      start_ts: 1,
      end_ts: 2,
      ...(agent ? { origin: { kind: "agent" } } : {}),
    },
  });
  for (const firstAgent of [true, false]) {
    const result = compressDiff([
      part("A", firstAgent),
      part("B", !firstAgent),
      part("C", !firstAgent),
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0][operation], "A");
    assert.equal(result[1][operation], "BC");
    assert.equal(result[0].meta.origin?.kind === "agent", firstAgent);
    assert.equal(result[1].meta.origin?.kind === "agent", !firstAgent);
  }
}
console.log(
  "Native History diff preserves human/agent boundaries (inserts and deletes).",
);
