import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function projectFileTree(project) {
  const entries = [],
    folders = [];
  function visit(folder, path = "/", parentFolderId = null) {
    const id = String(folder._id);
    folders.push({ id, name: folder.name, path, parentFolderId });
    for (const [items, type] of [
      [folder.docs, "document"],
      [folder.fileRefs, "file"],
    ]) {
      for (const item of items || [])
        entries.push({
          id: String(item._id),
          name: item.name,
          path: path + item.name,
          type,
          parentFolderId: id,
        });
    }
    for (const child of folder.folders || [])
      visit(child, `${path}${child.name}/`, id);
  }
  for (const root of project.rootFolder || []) visit(root);
  return { rootFolderId: folders[0]?.id ?? null, folders, entries };
}

// CE 6.3.2 private APIs. Use the same structure lock as native create/move/delete,
// then their withoutLock entry points so validation and mutation share one lock.
export function createFileBackend({
  ProjectGetter,
  ProjectEntityUpdateHandler,
  LockManager,
  EditorRealTimeController,
  SafePath,
  AgentError,
}) {
  const locked = (id, fn) =>
    LockManager.promises.runWithLock(
      "sequentialProjectStructureUpdateLock",
      id,
      fn,
    );
  const load = async (id) => {
    const project = await ProjectGetter.promises.getProject(id, {
      rootFolder: 1,
      rootDoc_id: 1,
      overleaf: 1,
    });
    if (!project) throw new AgentError("NOT_FOUND", "Project not found", 404);
    return { project, ...projectFileTree(project) };
  };
  function createTarget(
    { rootFolderId, folders, entries },
    parentId,
    name,
    kind,
  ) {
    const parentFolderId = parentId ?? rootFolderId;
    const parent = folders.find((folder) => folder.id === parentFolderId);
    if (!parent)
      throw new AgentError(
        "NOT_FOUND",
        "This parent folder does not belong to the project",
        404,
      );
    const path = parent.path + name + (kind === "folder" ? "/" : "");
    if (
      !SafePath.isCleanFilename(name) ||
      SafePath.isBlockedFilename(name) ||
      !SafePath.isAllowedLength(path)
    )
      throw new AgentError(
        "INVALID_NAME",
        "The name or resulting path is not valid",
      );
    if (
      [...entries, ...folders].some(
        (item) => item.parentFolderId === parentFolderId && item.name === name,
      )
    )
      throw new AgentError(
        "NAME_CONFLICT",
        "A file or folder with this name already exists",
        409,
      );
    return { name, path, parentFolderId };
  }
  return {
    async createFolder(projectId, userId, args, authorize) {
      return locked(projectId, async () => {
        const preview = {
          ...createTarget(
            await load(projectId),
            args.parentFolderId,
            args.name,
            "folder",
          ),
          type: "folder",
        };
        const { parentFolderId } = preview;
        await authorize();
        if (args.dryRun) return preview;
        const { folder } =
          await ProjectEntityUpdateHandler.promises.addFolder.withoutLock(
            projectId,
            parentFolderId,
            args.name,
            userId,
          );
        // Match the native folder event; unlike file events, it has no source slot.
        EditorRealTimeController.emitToRoom(
          projectId,
          "reciveNewFolder",
          parentFolderId,
          folder,
          userId,
        );
        return {
          ...preview,
          id: String(folder._id),
          folderId: String(folder._id),
        };
      });
    },
    async createFile(projectId, userId, args, authorize) {
      let directory;
      try {
        // The service has already validated content, encoding and decoded size.
        if (!args.dryRun && args.encoding === "base64") {
          directory = await mkdtemp(join(tmpdir(), "overleaf-agent-file-"));
          await writeFile(
            join(directory, "upload"),
            Buffer.from(args.content, "base64"),
            { mode: 0o600 },
          );
        }
        return await locked(projectId, async () => {
          const tree = await load(projectId);
          const { project } = tree;
          const { path, parentFolderId: folderId } = createTarget(
            tree,
            args.folderId,
            args.name,
            "file",
          );
          if (
            args.encoding === "utf8" &&
            !(project.overleaf?.history?.otMigrationStage > 0) &&
            /[\uD800-\uDFFF]/.test(args.content)
          )
            throw new AgentError(
              "UNSUPPORTED_TEXT",
              "This project uses ShareJS, which cannot accept emoji or other non-BMP characters. Chinese text is supported.",
            );
          const preview = {
            name: args.name,
            path,
            parentFolderId: folderId,
            type: args.encoding === "utf8" ? "document" : "file",
            bytes: Buffer.byteLength(
              args.content,
              args.encoding === "base64" ? "base64" : "utf8",
            ),
          };
          await authorize();
          if (args.dryRun) return preview;
          if (args.encoding === "utf8") {
            const { doc } =
              await ProjectEntityUpdateHandler.promises.addDocWithRanges.withoutLock(
                projectId,
                folderId,
                args.name,
                args.content.split("\n"),
                {},
                userId,
                "agent",
              );
            EditorRealTimeController.emitToRoom(
              projectId,
              "reciveNewDoc",
              folderId,
              doc,
              "agent",
              userId,
            );
            return { ...preview, id: String(doc._id), docId: String(doc._id) };
          }
          const { fileRef } =
            await ProjectEntityUpdateHandler.promises.addFile.withoutLock(
              projectId,
              folderId,
              args.name,
              join(directory, "upload"),
              undefined,
              userId,
              "agent",
            );
          EditorRealTimeController.emitToRoom(
            projectId,
            "reciveNewFile",
            folderId,
            fileRef,
            "agent",
            undefined,
            userId,
          );
          return { ...preview, id: String(fileRef._id) };
        });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
    async deleteFile(projectId, userId, args, authorize) {
      return locked(projectId, async () => {
        const { project, entries, folders } = await load(projectId);
        if (folders.some((folder) => folder.id === args.fileId))
          throw new AgentError(
            "FOLDER_DELETE_UNSUPPORTED",
            "Only individual documents and attachments can be deleted",
          );
        const file = entries.find((entry) => entry.id === args.fileId);
        if (!file)
          throw new AgentError(
            "NOT_FOUND",
            "This file does not belong to the project",
            404,
          );
        if (file.path !== args.expectedPath)
          throw new AgentError(
            "PATH_CONFLICT",
            "The file path has changed. Refresh the project tree before deleting.",
            409,
          );
        const preview = {
          ...file,
          wasRootDocument: String(project.rootDoc_id) === file.id,
        };
        await authorize();
        if (args.dryRun) return preview;
        await ProjectEntityUpdateHandler.promises.deleteEntity.withoutLock(
          projectId,
          file.id,
          file.type === "document" ? "doc" : "file",
          userId,
          "agent",
        );
        EditorRealTimeController.emitToRoom(
          projectId,
          "removeEntity",
          file.id,
          "agent",
        );
        return { ...preview, deleted: true };
      });
    },
  };
}
