import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from './schema.js';

const require = createRequire(import.meta.url);
const wasmPath = fileURLToPath(
  new URL('../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url)
);

/**
 * 打开（不存在则创建并初始化）SQLite 数据库。
 * sql.js 是 WASM 版 SQLite：数据在内存中，通过 save() 持久化为标准 .sqlite 文件。
 */
export async function openDatabase(file) {
  const SQL = await initSqlJs({
    locateFile: () =>
      existsSync(wasmPath) ? wasmPath : require.resolve('sql.js/dist/sql-wasm.wasm'),
  });

  const inMemory = !file || file === ':memory:';
  let db;
  if (!inMemory && existsSync(file)) {
    db = new SQL.Database(readFileSync(file));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  db.run('PRAGMA foreign_keys = ON');

  // 用写入串行化 + 落盘文件锁，模拟单一文件数据库的持久化行为。
  let chain = Promise.resolve();
  let dirty = false;

  const flush = () => {
    if (inMemory || !dirty) return;
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, Buffer.from(db.export()));
    renameSync(tmp, file);
    dirty = false;
  };

  return {
    /** 返回参数化查询行（sql.js 绑定） */
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    get(sql, params = []) {
      return this.all(sql, params)[0] ?? null;
    },
    run(sql, params = []) {
      db.run(sql, params);
      dirty = true;
      return { lastInsertRowid: db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0] };
    },
    /**
     * 串行执行一个写事务；函数体内可抛错，异常时回滚并拒绝后续落盘。
     * 写操作排队执行，保证 Node 单进程内发布事务的原子性。
     */
    transaction(fn) {
      const run = chain.then(async () => {
        db.run('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          db.run('COMMIT');
          flush();
          return result;
        } catch (err) {
          try {
            db.run('ROLLBACK');
          } catch {
            /* 连接失效时忽略回滚错误 */
          }
          throw err;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
    exec(sql) {
      db.run(sql);
    },
    close() {
      return chain.then(() => {
        flush();
        db.close();
      });
    },
  };
}
