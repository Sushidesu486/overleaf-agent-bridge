// MongoDB's unique index and revision checks apply across workers and sessions.
export async function createGitHubStore(db) {
  const accounts = db.collection("github_account_links");
  const flows = db.collection("github_link_flows");
  await accounts.createIndex(
    { githubUserId: 1 },
    {
      unique: true,
      partialFilterExpression: { githubUserId: { $type: "string" } },
    },
  );
  await flows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await flows.createIndex({ userId: 1 });
  return {
    getAccount: (_id) => accounts.findOne({ _id }),
    async ensureAccount(_id) {
      try {
        await accounts.updateOne(
          { _id },
          { $setOnInsert: { revision: 0 } },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      return accounts.findOne({ _id });
    },
    getFlow: (_id, now) => flows.findOne({ _id, expiresAt: { $gt: now } }),
    putFlow: (flow) =>
      flows.replaceOne({ _id: flow._id }, flow, { upsert: true }),
    consumeFlow: (_id, stateHash, now) =>
      flows.findOneAndUpdate(
        {
          _id,
          stateHash,
          stage: "authorize",
          expiresAt: { $gt: now },
        },
        { $set: { stage: "exchange" }, $unset: { verifier: "" } },
        { returnDocument: "before" },
      ),
    async saveCandidate(flow, candidate, now) {
      const result = await flows.updateOne(
        {
          _id: flow._id,
          stateHash: flow.stateHash,
          stage: "exchange",
          expiresAt: { $gt: now },
        },
        { $set: { ...candidate, stage: "confirm" }, $unset: { stateHash: "" } },
      );
      return result.modifiedCount === 1;
    },
    takeCandidate: (_id, candidateId, now) =>
      flows.findOneAndDelete({
        _id,
        candidateId,
        stage: "confirm",
        expiresAt: { $gt: now },
      }),
    cancelCandidate: (_id, candidateId) =>
      flows.deleteOne({ _id, candidateId }),
    deleteUserFlows: (userId) => flows.deleteMany({ userId }),
    async link(_id, candidate, now) {
      const result = await accounts.updateOne(
        {
          _id,
          revision: candidate.revision,
          $or: [
            { githubUserId: { $exists: false } },
            { githubUserId: candidate.githubUserId },
          ],
        },
        {
          $set: {
            githubUserId: candidate.githubUserId,
            githubLogin: candidate.githubLogin,
            linkedAt: now,
            verifiedAt: candidate.verifiedAt,
          },
          $inc: { revision: 1 },
        },
      );
      return result.modifiedCount === 1;
    },
    unlink: (_id) =>
      accounts.updateOne(
        { _id },
        {
          $unset: {
            githubUserId: "",
            githubLogin: "",
            linkedAt: "",
            verifiedAt: "",
          },
          $inc: { revision: 1 },
        },
      ),
  };
}
