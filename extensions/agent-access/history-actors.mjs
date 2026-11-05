/**
 * Present delegated edits as a separate actor in History. The persisted author
 * remains the human user; these IDs exist only in the history response, where
 * the stock UI uses them for "You" matching and author colours.
 */
export function presentHistoryActors(data, viewerId) {
  const entries = Array.isArray(data.diff)
    ? data.diff
    : Array.isArray(data.updates)
      ? data.updates
      : [];
  for (const entry of entries) {
    if (entry.meta?.origin?.kind !== "agent") continue;
    entry.meta.users = (entry.meta.users ?? []).map((user) => {
      // Keep the stock anonymous/deleted-user behaviour.
      if (!user?.id) return user;
      const userId = String(user.id);
      const ownerName =
        [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
        user.email?.split("@")[0] ||
        "Unknown user";
      const displayName =
        userId === String(viewerId) ? "Your agent" : `${ownerName}'s agent`;
      return {
        ...user,
        id: `agent:${userId}`,
        userId,
        actorType: "agent",
        displayName, // History author badges.
        name: displayName, // History diff tooltips.
      };
    });
  }
  return data;
}
