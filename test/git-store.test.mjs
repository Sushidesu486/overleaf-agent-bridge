import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createGitStore } from "../extensions/git-access/store.mjs";
import { createGitAccess } from "../extensions/git-access/access.mjs";

test(
  "real Mongo: token rotation never hides valid credentials from management",
  { skip: !process.env.GIT_TEST_MONGO_URL },
  async (t) => {
    const { MongoClient } = await import("mongodb");
    const mongo = await MongoClient.connect(process.env.GIT_TEST_MONGO_URL);
    const db = mongo.db(`git_access_check_${randomBytes(8).toString("hex")}`);
    t.after(async () => {
      await db.dropDatabase();
      await mongo.close();
    });
    const store = createGitStore(db);
    const project = "a".repeat(24),
      user = "b".repeat(24);
    const access = createGitAccess({
      store,
      users: {
        async get() {
          return { name: "Owner", email: "owner@example.invalid" };
        },
        async role() {
          return "owner";
        },
      },
    });
    await access.enable(user, project, true);
    const issue = () =>
      access.issue(user, project, {
        name: "Laptop",
        mode: "read",
        actor: "human",
      });
    const original = await issue();
    for (let i = 0; i < 101; i++) {
      const replacement = await issue();
      await access.revoke(user, project, replacement.id);
    }
    assert.deepEqual(
      (await access.status(user, project)).grants.map((g) => g.id),
      [original.id],
    );
    // Multiple active credentials must remain discoverable as well.
    for (let i = 0; i < 101; i++) await issue();
    const visible = (await access.status(user, project)).grants;
    assert.equal(visible.length, 102);
    assert.ok(visible.some((g) => g.id === original.id));
    await access.revoke(user, project, original.id);
    await assert.rejects(access.authorize(original.token, project), {
      code: "token_invalid",
    });
  },
);
