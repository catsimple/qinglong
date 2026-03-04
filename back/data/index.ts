import { Sequelize, Transaction } from 'sequelize';
import config from '../config/index';
import { join } from 'path';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: join(config.dbPath, 'database.sqlite'),
  logging: false,
  retry: {
    max: 10,
    match: ['SQLITE_BUSY: database is locked'],
  },
  pool: {
    max: 5,
    min: 2,
    idle: 30000,
    acquire: 30000,
    evict: 10000,
  },
  transactionType: Transaction.TYPES.IMMEDIATE,
});

const SQLITE_JOURNAL_MODES = new Set([
  'DELETE',
  'TRUNCATE',
  'PERSIST',
  'MEMORY',
  'WAL',
  'OFF',
]);
const SQLITE_SYNCHRONOUS_LEVELS = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);

export async function applySqlitePragmas() {
  const journalMode = (
    process.env.SQLITE_JOURNAL_MODE || 'WAL'
  ).toUpperCase();
  const synchronous = (
    process.env.SQLITE_SYNCHRONOUS || 'NORMAL'
  ).toUpperCase();
  const busyTimeout = Math.floor(
    Math.max(Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000), 0),
  );
  const cacheSize = Math.trunc(Number(process.env.SQLITE_CACHE_SIZE || -16000));

  const safeJournalMode = SQLITE_JOURNAL_MODES.has(journalMode)
    ? journalMode
    : 'WAL';
  const safeSynchronous = SQLITE_SYNCHRONOUS_LEVELS.has(synchronous)
    ? synchronous
    : 'NORMAL';

  const runPragma = async (query: string) => {
    try {
      await sequelize.query(query);
    } catch (error) {}
  };

  await runPragma(`PRAGMA journal_mode=${safeJournalMode}`);
  await runPragma(`PRAGMA synchronous=${safeSynchronous}`);
  await runPragma(`PRAGMA temp_store=MEMORY`);
  if (busyTimeout > 0) {
    await runPragma(`PRAGMA busy_timeout=${busyTimeout}`);
  }
  if (!isNaN(cacheSize) && cacheSize !== 0) {
    await runPragma(`PRAGMA cache_size=${cacheSize}`);
  }
}

export type ResponseType<T> = { code: number; data?: T; message?: string };
