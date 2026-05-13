import { isPgsql } from '@server/datasource';
import logger from '@server/logger';
import type { DataSource } from 'typeorm';

const ALL_TABLES = [
  'issue_comment',
  'issue',
  'season_request',
  'media_request',
  'season',
  'blocklist',
  'watchlist',
  'media',
  'user_push_subscription',
  'user_settings',
  'session',
  'discover_slider',
  'override_rule',
  'user',
];

export const revertBookChanges = async (
  dbConnection: DataSource
): Promise<void> => {
  // Check if this is an existing fork user
  let existingRecord: { name: string }[] = [];
  try {
    existingRecord = await dbConnection.query(
      `SELECT name FROM migrations WHERE name LIKE 'AddBookSupport%'`
    );
  } catch {
    return;
  }

  if (existingRecord.length === 0) {
    return;
  }

  // Check if the existing record matches the current AddBookSupport migration
  const currentMigration = dbConnection.migrations.find((m) =>
    (m.name as string).startsWith('AddBookSupport')
  );
  if (currentMigration && existingRecord[0].name === currentMigration.name) {
    return;
  }

  logger.info('Previous fork version detected, backing up data', {
    label: 'Book Migration',
  });

  // Back up every table
  try {
    for (const table of ALL_TABLES) {
      await dbConnection.query(`DROP TABLE IF EXISTS "_backup_${table}"`);
      await dbConnection.query(
        `CREATE TABLE "_backup_${table}" AS SELECT * FROM "${table}"`
      );
    }
  } catch (error) {
    logger.error('Failed to back up tables', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // Drop every table so migrations run on a clean database
  try {
    for (const table of ALL_TABLES) {
      if (isPgsql) {
        await dbConnection.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      } else {
        await dbConnection.query(`DROP TABLE IF EXISTS "${table}"`);
      }
    }
  } catch (error) {
    logger.error('Failed to drop tables', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // Clear all migration records so everything runs fresh
  try {
    await dbConnection.query(`DELETE FROM migrations`);
  } catch (error) {
    logger.error('Failed to clean migration records', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  logger.info('Data backed up, ready for fresh migration', {
    label: 'Book Migration',
  });
};

export const restoreBookData = async (
  dbConnection: DataSource
): Promise<void> => {
  // Check if backups exist
  if (isPgsql) {
    const check = await dbConnection.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = '_backup_media'`
    );
    if (check.length === 0) return;
  } else {
    const check = await dbConnection.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='_backup_media'`
    );
    if (check.length === 0) return;
  }

  logger.info('Restoring data from backup', { label: 'Book Migration' });

  // Disable FK checks during restore
  if (isPgsql) {
    await dbConnection.query(`SET session_replication_role = 'replica'`);
  } else {
    await dbConnection.query(`PRAGMA foreign_keys = OFF`);
  }

  // Fix old fork data before restoring
  // Copy hcId into tmdbId for book entries that had NULL tmdbId
  try {
    const backupMediaCols = await getColumnNames(dbConnection, '_backup_media');
    if (backupMediaCols.includes('hcId')) {
      await dbConnection.query(
        `UPDATE "_backup_media" SET "tmdbId" = "hcId" WHERE "tmdbId" IS NULL AND "hcId" IS NOT NULL`
      );
    }
  } catch (error) {
    logger.error('Failed to fix old fork media data', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // Rename old fork columns in backup tables so they match the new schema
  // blocklist: externalId -> tmdbId, blacklistedTags -> blocklistedTags
  try {
    const blocklistCols = await getColumnNames(
      dbConnection,
      '_backup_blocklist'
    );
    if (blocklistCols.includes('externalId')) {
      if (isPgsql) {
        await dbConnection.query(
          `ALTER TABLE "_backup_blocklist" RENAME COLUMN "externalId" TO "tmdbId"`
        );
      } else {
        await dbConnection.query(
          `ALTER TABLE "_backup_blocklist" ADD COLUMN "tmdbId" integer`
        );
        await dbConnection.query(
          `UPDATE "_backup_blocklist" SET "tmdbId" = "externalId"`
        );
      }
    }
    if (blocklistCols.includes('blacklistedTags')) {
      if (isPgsql) {
        await dbConnection.query(
          `ALTER TABLE "_backup_blocklist" RENAME COLUMN "blacklistedTags" TO "blocklistedTags"`
        );
      } else {
        await dbConnection.query(
          `ALTER TABLE "_backup_blocklist" ADD COLUMN "blocklistedTags" varchar`
        );
        await dbConnection.query(
          `UPDATE "_backup_blocklist" SET "blocklistedTags" = "blacklistedTags"`
        );
      }
    }
  } catch (error) {
    logger.error('Failed to fix old fork blocklist data', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // media: statusAlt -> status4k, serviceIdAlt -> serviceId4k, etc
  try {
    const mediaCols = await getColumnNames(dbConnection, '_backup_media');
    if (mediaCols.includes('statusAlt')) {
      const renames: [string, string][] = [
        ['statusAlt', 'status4k'],
        ['serviceIdAlt', 'serviceId4k'],
        ['externalServiceIdAlt', 'externalServiceId4k'],
        ['externalServiceSlugAlt', 'externalServiceSlug4k'],
        ['ratingKeyAlt', 'ratingKey4k'],
        ['jellyfinMediaIdAlt', 'jellyfinMediaId4k'],
      ];
      for (const [oldName, newName] of renames) {
        if (isPgsql) {
          await dbConnection.query(
            `ALTER TABLE "_backup_media" RENAME COLUMN "${oldName}" TO "${newName}"`
          );
        } else {
          await dbConnection.query(
            `ALTER TABLE "_backup_media" ADD COLUMN "${newName}" integer`
          );
          await dbConnection.query(
            `UPDATE "_backup_media" SET "${newName}" = "${oldName}"`
          );
        }
      }
    }
  } catch (error) {
    logger.error('Failed to fix old fork media column names', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // media_request: isAlt -> is4k
  try {
    const requestCols = await getColumnNames(
      dbConnection,
      '_backup_media_request'
    );
    if (requestCols.includes('isAlt')) {
      if (isPgsql) {
        await dbConnection.query(
          `ALTER TABLE "_backup_media_request" RENAME COLUMN "isAlt" TO "is4k"`
        );
      } else {
        await dbConnection.query(
          `ALTER TABLE "_backup_media_request" ADD COLUMN "is4k" boolean DEFAULT 0`
        );
        await dbConnection.query(
          `UPDATE "_backup_media_request" SET "is4k" = "isAlt"`
        );
      }
    }
  } catch (error) {
    logger.error('Failed to fix old fork media_request column names', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // Restore each table — copy shared columns from backup into new schema
  try {
    for (const table of ALL_TABLES) {
      const backupCols = await getColumnNames(dbConnection, `_backup_${table}`);
      const newCols = await getColumnNames(dbConnection, table);
      const shared = backupCols.filter((c) => newCols.includes(c));

      if (shared.length === 0) continue;

      const cols = shared.map((c) => `"${c}"`).join(', ');

      await dbConnection.query(`DELETE FROM "${table}"`);
      await dbConnection.query(
        `INSERT INTO "${table}" (${cols}) SELECT ${cols} FROM "_backup_${table}"`
      );

      if (isPgsql) {
        try {
          await dbConnection.query(
            `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
          );
        } catch {
          // Not all tables have serial ids
        }
      }
    }
  } catch (error) {
    logger.error('Failed to restore data', {
      label: 'Book Migration',
      error: error.message,
    });
    process.exit(1);
  }

  // Re-enable FK checks
  if (isPgsql) {
    await dbConnection.query(`SET session_replication_role = 'origin'`);
  } else {
    await dbConnection.query(`PRAGMA foreign_keys = ON`);
  }

  // Clean up backup tables
  for (const table of ALL_TABLES) {
    await dbConnection.query(`DROP TABLE IF EXISTS "_backup_${table}"`);
  }

  logger.info('Data restored successfully', { label: 'Book Migration' });
};

const getColumnNames = async (
  dbConnection: DataSource,
  table: string
): Promise<string[]> => {
  if (isPgsql) {
    const rows: { column_name: string }[] = await dbConnection.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    return rows.map((r) => r.column_name);
  }
  const rows: { name: string }[] = await dbConnection.query(
    `PRAGMA table_info("${table}")`
  );
  return rows.map((r) => r.name);
};
