'use strict';

const { joinBy } = require('@strapi/utils');
const { getService } = require('../utils');
const { ACTIONS, FOLDER_MODEL_UID, FILE_MODEL_UID } = require('../constants');
const {
  validateDeleteManyFoldersFiles,
  validateMoveManyFoldersFiles,
} = require('./validation/admin/folder-file');

module.exports = {
  async deleteMany(ctx) {
    const { body } = ctx.request;
    const {
      state: { userAbility },
    } = ctx;

    const pmFolder = strapi.admin.services.permission.createPermissionsManager({
      ability: ctx.state.userAbility,
      model: FOLDER_MODEL_UID,
    });

    const pmFile = strapi.admin.services.permission.createPermissionsManager({
      ability: userAbility,
      action: ACTIONS.read,
      model: FILE_MODEL_UID,
    });

    await validateDeleteManyFoldersFiles(body);

    const fileService = getService('file');
    const folderService = getService('folder');

    const deletedFiles = await fileService.deleteByIds(body.fileIds);
    const deletedFolders = await folderService.deleteByIds(body.folderIds);

    ctx.body = {
      data: {
        files: await pmFile.sanitizeOutput(deletedFiles),
        folders: await pmFolder.sanitizeOutput(deletedFolders),
      },
    };
  },
  async moveMany(ctx) {
    const { body } = ctx.request;
    const {
      state: { userAbility },
    } = ctx;

    const pmFolder = strapi.admin.services.permission.createPermissionsManager({
      ability: ctx.state.userAbility,
      model: FOLDER_MODEL_UID,
    });

    const pmFile = strapi.admin.services.permission.createPermissionsManager({
      ability: userAbility,
      action: ACTIONS.read,
      model: FILE_MODEL_UID,
    });

    await validateMoveManyFoldersFiles(body);
    const { folderIds = [], fileIds = [], destinationFolderId } = body;

    const trx = await strapi.db.transaction();
    try {
      // fetch folders
      const existingFolders = await strapi.db
        .queryBuilder(FOLDER_MODEL_UID)
        .select(['id', 'uid', 'path'])
        .where({ id: { $in: folderIds } })
        .transacting(trx)
        .forUpdate()
        .execute();

      // fetch files
      const existingFiles = await strapi.db
        .queryBuilder(FILE_MODEL_UID)
        .select(['id'])
        .where({ id: { $in: fileIds } })
        .transacting(trx)
        .forUpdate()
        .execute();

      // fetch destinationFolder path
      let destinationFolderPath = '/';
      if (destinationFolderId !== null) {
        const destinationFolder = await strapi.db
          .queryBuilder(FOLDER_MODEL_UID)
          .select('path')
          .where({ id: destinationFolderId })
          .transacting(trx)
          .first()
          .execute();
        destinationFolderPath = destinationFolder.path;
      }

      const fileTable = strapi.getModel(FILE_MODEL_UID).collectionName;
      const folderTable = strapi.getModel(FOLDER_MODEL_UID).collectionName;
      const folderPathColName = strapi.db.metadata.get(FILE_MODEL_UID).attributes.folderPath
        .columnName;
      const pathColName = strapi.db.metadata.get(FOLDER_MODEL_UID).attributes.path.columnName;

      if (existingFolders.length > 0) {
        // update folders' parent relation (delete + insert; upsert not possible)
        const joinTable = strapi.db.metadata.get(FOLDER_MODEL_UID).attributes.parent.joinTable;
        await strapi.db
          .queryBuilder(joinTable.name)
          .transacting(trx)
          .delete()
          .where({ [joinTable.joinColumn.name]: { $in: folderIds } })
          .execute();
        await strapi.db
          .queryBuilder(joinTable.name)
          .transacting(trx)
          .insert(
            existingFolders.map(folder => ({
              [joinTable.inverseJoinColumn.name]: destinationFolderId,
              [joinTable.joinColumn.name]: folder.id,
            }))
          )
          .execute();

        for (const existingFolder of existingFolders) {
          // update path for folders themselves & folders below
          await strapi.db
            .connection(folderTable)
            .transacting(trx)
            .where(pathColName, 'like', `${existingFolder.path}%`)
            .update(
              pathColName,
              strapi.db.connection.raw('REPLACE(??, ?, ?)', [
                pathColName,
                existingFolder.path,
                joinBy('/', destinationFolderPath, existingFolder.uid),
              ])
            );

          // update path of files below
          await strapi.db
            .connection(fileTable)
            .transacting(trx)
            .where(folderPathColName, 'like', `${existingFolder.path}%`)
            .update(
              folderPathColName,
              strapi.db.connection.raw('REPLACE(??, ?, ?)', [
                folderPathColName,
                existingFolder.path,
                joinBy('/', destinationFolderPath, existingFolder.uid),
              ])
            );
        }
      }

      if (existingFiles.length > 0) {
        // update files' folder relation (delete + insert; upsert not possible)
        const fileJoinTable = strapi.db.metadata.get(FILE_MODEL_UID).attributes.folder.joinTable;
        await strapi.db
          .queryBuilder(fileJoinTable.name)
          .transacting(trx)
          .delete()
          .where({ [fileJoinTable.joinColumn.name]: { $in: fileIds } })
          .execute();
        await strapi.db
          .queryBuilder(fileJoinTable.name)
          .transacting(trx)
          .insert(
            existingFiles.map(file => ({
              [fileJoinTable.inverseJoinColumn.name]: destinationFolderId,
              [fileJoinTable.joinColumn.name]: file.id,
            }))
          )
          .execute();

        // update files main fields (path + updatedBy)
        await strapi.db
          .connection(fileTable)
          .transacting(trx)
          .whereIn('id', fileIds)
          .update(folderPathColName, destinationFolderPath);
      }

      await trx.commit();
    } catch (e) {
      await trx.rollback();
      throw e;
    }

    const updatedFolders = await strapi.entityService.findMany(FOLDER_MODEL_UID, {
      filters: { id: { $in: folderIds } },
    });
    const updatedFiles = await strapi.entityService.findMany(FILE_MODEL_UID, {
      filters: { id: { $in: fileIds } },
    });

    ctx.body = {
      data: {
        files: await pmFile.sanitizeOutput(updatedFiles),
        folders: await pmFolder.sanitizeOutput(updatedFolders),
      },
    };
  },
};
