import logger from '@server/logger';
import type { DataSource } from 'typeorm';

export interface ForkColumn {
  table: string;
  column: string;
  type: string;
}

export const FORK_COLUMNS: ForkColumn[] = [
  { table: 'media_request', column: 'metadataProfileId', type: 'integer' },
  { table: 'override_rule', column: 'readarrServiceId', type: 'integer' },
  { table: 'override_rule', column: 'metadataProfileId', type: 'integer' },
  { table: 'user', column: 'bookQuotaLimit', type: 'integer' },
  { table: 'user', column: 'bookQuotaDays', type: 'integer' },
];

const BACKUP_PREFIX = '_fork_backup_';
const LOG_LABEL = 'Fork Schema';

export const applyForkSchema = async (
  dbConnection: DataSource
): Promise<void> => {
  await abortIfOldForkDatabase(dbConnection);
  await snapshotForkColumns(dbConnection);
  await runUpstreamMigrations(dbConnection);
  await ensureForkColumns(dbConnection);
  await ensurePermissionsColumnIsBigint(dbConnection);
  await restoreForkColumns(dbConnection);
};

// Check for old fork user
const abortIfOldForkDatabase = async (
  dbConnection: DataSource
): Promise<void> => {
  try {
    const oldForkMarkers: { table: string; column: string }[] = [
      { table: 'media', column: 'hcId' },
      { table: 'media_request', column: 'isAlt' },
      { table: 'blocklist', column: 'externalId' },
    ];

    for (const marker of oldForkMarkers) {
      if (!(await tableExists(dbConnection, marker.table))) {
        continue;
      }
      const columns = await getColumnNames(dbConnection, marker.table);
      if (columns.includes(marker.column)) {
        logger.error(
          `This database was created by an old version of the fork (found "${marker.table}"."${marker.column}"), which this version can no longer upgrade. Please upgrade to v3.2.0 first, or start with a fresh database.`,
          { label: LOG_LABEL }
        );
        process.exit(1);
      }
    }
  } catch (error) {
    logger.error('Failed to check for old fork database', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const snapshotForkColumns = async (dbConnection: DataSource): Promise<void> => {
  let hasPendingMigrations = false;
  try {
    hasPendingMigrations = await dbConnection.showMigrations();
  } catch (error) {
    logger.error('Failed to check for pending migrations', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }

  if (!hasPendingMigrations) {
    return;
  }

  try {
    for (const table of forkTables()) {
      const backupTable = `${BACKUP_PREFIX}${table}`;

      if (await tableExists(dbConnection, backupTable)) {
        logger.warn(
          `Found existing backup table "${backupTable}" from an interrupted upgrade, keeping it`,
          { label: LOG_LABEL }
        );
        continue;
      }

      // the table does not exist yet, nothing to back up, fresh install
      if (!(await tableExists(dbConnection, table))) {
        continue;
      }

      const existingColumns = await getColumnNames(dbConnection, table);
      const columnsToBackUp = forkColumnsFor(table).filter((forkColumn) =>
        existingColumns.includes(forkColumn.column)
      );

      // no fork columns, existing seerr user migrating to fork
      if (columnsToBackUp.length === 0) {
        continue;
      }

      logger.info(
        `Backing up fork columns of "${table}" before running pending migrations`,
        { label: LOG_LABEL }
      );

      const columnList = columnsToBackUp
        .map((forkColumn) => `"${forkColumn.column}"`)
        .join(', ');
      await dbConnection.query(
        `CREATE TABLE "${backupTable}" AS SELECT "id", ${columnList} FROM "${table}"`
      );

      await dbConnection.query(
        `CREATE INDEX "${backupTable}_id_idx" ON "${backupTable}" ("id")`
      );
    }
  } catch (error) {
    logger.error('Failed to back up fork columns', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const runUpstreamMigrations = async (
  dbConnection: DataSource
): Promise<void> => {
  try {
    await dbConnection.runMigrations();
  } catch (error) {
    logger.error('Failed to run database migrations', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const ensureForkColumns = async (dbConnection: DataSource): Promise<void> => {
  try {
    for (const forkColumn of FORK_COLUMNS) {
      if (!(await tableExists(dbConnection, forkColumn.table))) {
        logger.warn(
          `Expected table "${forkColumn.table}" does not exist, skipping fork column "${forkColumn.column}"`,
          { label: LOG_LABEL }
        );
        continue;
      }

      const existingColumns = await getColumnNames(
        dbConnection,
        forkColumn.table
      );
      if (existingColumns.includes(forkColumn.column)) {
        continue;
      }

      logger.info(
        `Adding fork column "${forkColumn.table}"."${forkColumn.column}"`,
        { label: LOG_LABEL }
      );
      await dbConnection.query(
        `ALTER TABLE "${forkColumn.table}" ADD COLUMN "${forkColumn.column}" ${forkColumn.type}`
      );
    }
  } catch (error) {
    logger.error('Failed to add fork columns', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const ensurePermissionsColumnIsBigint = async (
  dbConnection: DataSource
): Promise<void> => {
  if (dbConnection.options.type !== 'postgres') {
    return;
  }

  try {
    const rows: { data_type: string }[] = await dbConnection.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'permissions'`
    );
    if (rows.length > 0 && rows[0].data_type === 'integer') {
      logger.info('Widening "user"."permissions" to bigint', {
        label: LOG_LABEL,
      });
      await dbConnection.query(
        `ALTER TABLE "user" ALTER COLUMN "permissions" TYPE bigint`
      );
    }
  } catch (error) {
    logger.error('Failed to widen "user"."permissions" to bigint', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const restoreForkColumns = async (dbConnection: DataSource): Promise<void> => {
  try {
    for (const table of forkTables()) {
      const backupTable = `${BACKUP_PREFIX}${table}`;
      if (!(await tableExists(dbConnection, backupTable))) {
        continue;
      }

      logger.info(`Restoring fork columns of "${table}" from backup`, {
        label: LOG_LABEL,
      });

      // Only restore columns that are both in the backup and in the current
      // manifest, so a backup written by an older fork version stays valid
      const backupColumns = await getColumnNames(dbConnection, backupTable);
      const columnsToRestore = forkColumnsFor(table).filter((forkColumn) =>
        backupColumns.includes(forkColumn.column)
      );

      for (const forkColumn of columnsToRestore) {
        await dbConnection.query(
          `UPDATE "${table}" SET "${forkColumn.column}" = (SELECT b."${forkColumn.column}" FROM "${backupTable}" b WHERE b."id" = "${table}"."id")`
        );
      }

      await dbConnection.query(`DROP TABLE "${backupTable}"`);
    }
  } catch (error) {
    logger.error('Failed to restore fork columns', {
      label: LOG_LABEL,
      error: error.message,
    });
    process.exit(1);
  }
};

const forkTables = (): string[] => {
  return Array.from(
    new Set(FORK_COLUMNS.map((forkColumn) => forkColumn.table))
  );
};

const forkColumnsFor = (table: string): ForkColumn[] => {
  return FORK_COLUMNS.filter((forkColumn) => forkColumn.table === table);
};

const tableExists = async (
  dbConnection: DataSource,
  table: string
): Promise<boolean> => {
  if (dbConnection.options.type === 'postgres') {
    const rows = await dbConnection.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [table]
    );
    return rows.length > 0;
  }
  const rows = await dbConnection.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return rows.length > 0;
};

const getColumnNames = async (
  dbConnection: DataSource,
  table: string
): Promise<string[]> => {
  if (dbConnection.options.type === 'postgres') {
    const rows: { column_name: string }[] = await dbConnection.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    return rows.map((row) => row.column_name);
  }
  const rows: { name: string }[] = await dbConnection.query(
    `PRAGMA table_info("${table}")`
  );
  return rows.map((row) => row.name);
};
