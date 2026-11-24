/**
 * Драйвер PostgreSQL: пул соединений поверх собственного клиента протокола.
 * Включается переменной DATABASE_URL — прикладной код не меняется.
 */
import { toPostgres } from "../dialect.js";
import { Connection, parseConnectionString } from "./pg-protocol.js";

/** INSERT без RETURNING не сообщает идентификатор — добавляем его сами. */
function withReturningId(sql) {
  if (!/^\s*insert\s/i.test(sql)) return { sql, expectsId: false };
  if (/\breturning\b/i.test(sql)) return { sql, expectsId: true };
  return { sql: `${sql.replace(/;\s*$/, "")} RETURNING id`, expectsId: true };
}

class Pool {
  constructor(options, max) {
    this.options = options;
    this.max = Math.max(1, max);
    this.idle = [];
    this.size = 0;
    this.waiting = [];
    this.closed = false;
  }

  async acquire() {
    if (this.closed) throw new Error("Пул соединений остановлен");

    while (this.idle.length) {
      const connection = this.idle.pop();
      if (!connection.closed) return connection;
      this.size -= 1; // соединение отвалилось, пока лежало в пуле
    }

    if (this.size < this.max) {
      this.size += 1;
      try {
        return await new Connection(this.options).connect();
      } catch (err) {
        this.size -= 1;
        throw err;
      }
    }

    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  release(connection) {
    if (connection.closed) {
      this.size -= 1;
      return;
    }
    const next = this.waiting.shift();
    if (next) return next.resolve(connection);
    this.idle.push(connection);
  }

  /** Соединение испорчено (сеть, транзакция в ошибке) — выбрасываем, а не возвращаем в пул. */
  discard(connection) {
    this.size -= 1;
    connection.end().catch(() => {});
    const next = this.waiting.shift();
    if (next) {
      this.size += 1;
      new Connection(this.options)
        .connect()
        .then((fresh) => next.resolve(fresh))
        .catch((err) => {
          this.size -= 1;
          next.reject(err);
        });
    }
  }

  async withConnection(fn) {
    const connection = await this.acquire();
    try {
      const result = await fn(connection);
      this.release(connection);
      return result;
    } catch (err) {
      if (connection.closed) this.size -= 1;
      else this.release(connection);
      throw err;
    }
  }

  async end() {
    this.closed = true;
    for (const connection of this.idle) await connection.end();
    this.idle = [];
    this.size = 0;
  }
}

export async function createPostgresDriver({ url, poolSize = 10 }) {
  const options = parseConnectionString(url);
  const pool = new Pool(options, poolSize);

  // Проверка доступности на старте: лучше упасть сразу, чем на первом запросе клиента.
  await pool.withConnection((connection) => connection.query("SELECT 1"));

  const run = (sql, params) => pool.withConnection((c) => c.query(toPostgres(sql), params));

  return {
    kind: "postgres",
    host: options.host,
    database: options.database,

    async all(sql, params = []) {
      const { rows } = await run(sql, params);
      return rows;
    },

    async get(sql, params = []) {
      const { rows } = await run(sql, params);
      return rows[0] ?? null;
    },

    async run(sql, params = []) {
      const { sql: finalSql, expectsId } = withReturningId(sql);
      const { rows, rowCount } = await run(finalSql, params);
      return {
        lastId: expectsId ? Number(rows[0]?.id ?? 0) : 0,
        changes: Number(rowCount || 0),
      };
    },

    async exec(sql) {
      await pool.withConnection((c) => c.exec(sql));
    },

    /**
     * Транзакция закреплена за одним соединением: обработчик получает scoped-драйвер
     * и обязан работать через него, иначе запросы уйдут мимо BEGIN в соседнее соединение.
     */
    async transaction(fn) {
      const connection = await pool.acquire();
      const scoped = {
        kind: "postgres",
        all: async (sql, params = []) => (await connection.query(toPostgres(sql), params)).rows,
        get: async (sql, params = []) => (await connection.query(toPostgres(sql), params)).rows[0] ?? null,
        run: async (sql, params = []) => {
          const { sql: finalSql, expectsId } = withReturningId(sql);
          const { rows, rowCount } = await connection.query(toPostgres(finalSql), params);
          return { lastId: expectsId ? Number(rows[0]?.id ?? 0) : 0, changes: Number(rowCount || 0) };
        },
        exec: (sql) => connection.exec(sql),
      };

      try {
        await connection.exec("BEGIN");
        const result = await fn(scoped);
        await connection.exec("COMMIT");
        pool.release(connection);
        return result;
      } catch (err) {
        try {
          await connection.exec("ROLLBACK");
          pool.release(connection);
        } catch {
          pool.discard(connection);
        }
        throw err;
      }
    },

    /**
     * Логическая выгрузка в JSONL: работает без pg_dump на хосте,
     * поэтому доступна и в контейнере, где бинарников PostgreSQL нет.
     */
    async dumpTables(tables) {
      const dump = {};
      for (const table of tables) {
        dump[table] = await this.all(`SELECT * FROM ${table} ORDER BY id`);
      }
      return dump;
    },

    async close() {
      await pool.end();
    },
  };
}
