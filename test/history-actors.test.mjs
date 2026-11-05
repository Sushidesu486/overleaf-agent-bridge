import assert from "node:assert/strict";
import test from "node:test";
import { presentHistoryActors } from "../extensions/agent-access/history-actors.mjs";

const owner = {
  id: "6aec4ab54452fad2d1107eae",
  first_name: "Shouss",
  last_name: "Lab",
  email: "lab-human@example.invalid",
};

test("History distinguishes delegated and manual edits by the same owner", () => {
  const manual = { meta: { users: [owner] } };
  const delegated = { meta: { users: [owner], origin: { kind: "agent" } } };
  const data = { updates: [delegated, manual] };
  assert.equal(presentHistoryActors(data, owner.id), data);
  assert.equal(delegated.meta.users[0].displayName, "Your agent");
  assert.equal(delegated.meta.users[0].name, "Your agent");
  assert.equal(delegated.meta.users[0].id, `agent:${owner.id}`);
  assert.equal(delegated.meta.users[0].userId, owner.id);
  assert.equal(delegated.meta.users[0].actorType, "agent");
  assert.equal(manual.meta.users[0], owner);
  assert.equal(owner.id, "6aec4ab54452fad2d1107eae");
  assert.equal(owner.displayName, undefined);
});

test("collaborators see the owner's name in badges and diff tooltips", () => {
  const data = {
    diff: [{ i: "text", meta: { users: [owner], origin: { kind: "agent" } } }],
  };
  presentHistoryActors(data, "another-user");
  const actor = data.diff[0].meta.users[0];
  assert.equal(actor.displayName, "Shouss Lab's agent");
  assert.equal(actor.name, actor.displayName);
  assert.equal(actor.userId, owner.id);
});

test("other sources, missing users and unrelated history responses are preserved", () => {
  const upload = { meta: { users: [owner], origin: { kind: "upload" } } };
  const missing = {
    meta: { users: [null, undefined], origin: { kind: "agent" } },
  };
  const emailOnly = { id: "email-only", email: "alice@example.invalid" };
  const agent = { meta: { users: [emailOnly], origin: { kind: "agent" } } };
  presentHistoryActors({ updates: [upload, missing, agent, {}] }, null);
  assert.equal(upload.meta.users[0], owner);
  assert.deepEqual(missing.meta.users, [null, undefined]);
  assert.equal(agent.meta.users[0].displayName, "alice's agent");
  assert.deepEqual(presentHistoryActors({ files: [] }, owner.id), {
    files: [],
  });
});
