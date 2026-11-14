export function createGitStore(db) {
  const grants = db.collection("git_grants");
  const links = db.collection("git_project_links");
  return {
    async putGrant(grant) {
      await grants.insertOne({ _id: grant.id, ...grant });
    },
    async getGrant(id) {
      return grants.findOne({ _id: id }, { projection: { _id: 0 } });
    },
    async listGrants(userId, projectId) {
      return grants
        .find(
          { userId, projectId, revokedAt: null },
          { projection: { _id: 0 } },
        )
        .sort({ createdAt: -1 })
        .toArray();
    },
    async revoke(id, userId) {
      await grants.updateOne(
        { _id: id, userId },
        { $set: { revokedAt: new Date().toISOString() } },
      );
    },
    async touch(id) {
      await grants.updateOne(
        { _id: id },
        { $set: { lastUsedAt: new Date().toISOString() } },
      );
    },
    async getLink(projectId) {
      return links.findOne({ _id: projectId });
    },
    async setEnabled(projectId, enabled) {
      await links.updateOne(
        { _id: projectId },
        { $set: { enabled } },
        { upsert: true },
      );
    },
  };
}
