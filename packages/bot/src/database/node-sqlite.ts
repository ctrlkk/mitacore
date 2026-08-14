import { DatabaseSync } from "node:sqlite";
import { entityKind } from "drizzle-orm/entity";
import { DefaultLogger, NoopLogger, type Logger } from "drizzle-orm/logger";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from "drizzle-orm/relations";
import { fillPlaceholders, type Query, sql } from "drizzle-orm/sql/sql";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types";
import {
  type PreparedQueryConfig,
  SQLitePreparedQuery,
  type SQLiteExecuteMethod,
  SQLiteSession,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core/session";
import * as drizzleUtils from "drizzle-orm/utils";
import type { DrizzleConfig } from "drizzle-orm/utils";

type Statement = ReturnType<DatabaseSync["prepare"]>;
type StatementResult = ReturnType<Statement["run"]>;
const mapResultRow = (drizzleUtils as Record<string, unknown>).mapResultRow as (
  fields: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
) => unknown;

class NodeSQLiteDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends BaseSQLiteDatabase<
  "sync",
  StatementResult,
  TSchema
> {
  static override readonly [entityKind] = "NodeSQLiteDatabase";
}

class NodeSQLiteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<"sync", StatementResult, TFullSchema, TSchema> {
  static override readonly [entityKind] = "NodeSQLiteSession";

  private readonly logger: Logger;

  constructor(
    private readonly client: DatabaseSync,
    private readonly nodeDialect: SQLiteSyncDialect,
    private readonly schema: RelationalSchemaConfig<TSchema> | undefined,
    logger?: Logger,
  ) {
    super(nodeDialect);
    this.logger = logger ?? new NoopLogger();
  }

  prepareQuery<T extends PreparedQueryConfig & { type: "sync" }>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ): NodeSQLitePreparedQuery<T> {
    return new NodeSQLitePreparedQuery(
      this.client.prepare(query.sql),
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    ) as NodeSQLitePreparedQuery<T>;
  }

  override transaction<T>(
    transaction: (tx: NodeSQLiteTransaction<TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const behavior = config.behavior?.toUpperCase() ?? "DEFERRED";
    const tx = new NodeSQLiteTransaction("sync", this.nodeDialect, this, this.schema);
    this.client.exec(`BEGIN ${behavior}`);
    try {
      const result = transaction(tx);
      this.client.exec("COMMIT");
      return result;
    } catch (error) {
      this.client.exec("ROLLBACK");
      throw error;
    }
  }
}

class NodeSQLiteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<"sync", StatementResult, TFullSchema, TSchema> {
  static override readonly [entityKind] = "NodeSQLiteTransaction";

  constructor(
    resultType: "sync",
    private readonly nodeDialect: SQLiteSyncDialect,
    private readonly nodeSession: NodeSQLiteSession<TFullSchema, TSchema>,
    private readonly nodeSchema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex?: number,
  ) {
    super(resultType, nodeDialect, nodeSession, nodeSchema, nestedIndex);
  }

  override transaction<T>(transaction: (tx: NodeSQLiteTransaction<TFullSchema, TSchema>) => T): T {
    const savepointName = `sp${this.nestedIndex}`;
    const tx = new NodeSQLiteTransaction(
      "sync",
      this.nodeDialect,
      this.nodeSession,
      this.nodeSchema,
      this.nestedIndex + 1,
    );
    this.nodeSession.run(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = transaction(tx);
      this.nodeSession.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (error) {
      this.nodeSession.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}

class NodeSQLitePreparedQuery<
  T extends PreparedQueryConfig & { type: "sync" } = PreparedQueryConfig & { type: "sync" },
> extends SQLitePreparedQuery<T> {
  static override readonly [entityKind] = "NodeSQLitePreparedQuery";

  constructor(
    private readonly statement: Statement,
    query: Query,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    private readonly isArrayMode: boolean,
    private readonly customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    super("sync", executeMethod, query);
  }

  run(placeholderValues?: Record<string, unknown>): StatementResult {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    return this.statement.run(...(params as Parameters<Statement["run"]>));
  }

  all(placeholderValues?: Record<string, unknown>): T["all"] {
    if (!this.fields && !this.customResultMapper) {
      const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
      this.logger.logQuery(this.query.sql, params);
      return this.statement.all(...(params as Parameters<Statement["all"]>)) as T["all"];
    }

    const rows = this.values(placeholderValues) as unknown[][];
    if (this.customResultMapper) return this.customResultMapper(rows) as T["all"];
    return rows.map((row) => mapResultRow(this.fields!, row, this.getJoinsNotNullableMap())) as T["all"];
  }

  get(placeholderValues?: Record<string, unknown>): T["get"] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const row = this.statement.get(...(params as Parameters<Statement["get"]>));
    if (!row) return undefined as T["get"];
    if (!this.fields && !this.customResultMapper) return row as T["get"];

    const values = Object.values(row);
    if (this.customResultMapper) return this.customResultMapper([values]) as T["get"];
    return mapResultRow(this.fields!, values, this.getJoinsNotNullableMap()) as T["get"];
  }

  values(placeholderValues?: Record<string, unknown>): T["values"] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    return this.statement
      .all(...(params as Parameters<Statement["all"]>))
      .map((row) => Object.values(row)) as T["values"];
  }

  /** @internal */
  isResponseInArrayMode(): boolean {
    return this.isArrayMode;
  }

  private getJoinsNotNullableMap(): Record<string, boolean> | undefined {
    return (this as { joinsNotNullableMap?: Record<string, boolean> }).joinsNotNullableMap;
  }
}

export function drizzle<TSchema extends Record<string, unknown>>(
  client: DatabaseSync,
  config: DrizzleConfig<TSchema> = {},
): NodeSQLiteDatabase<TSchema> & { $client: DatabaseSync } {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  const logger = config.logger === true ? new DefaultLogger() : config.logger || undefined;
  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;

  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new NodeSQLiteSession(client, dialect, schema, logger);
  const db = new NodeSQLiteDatabase("sync", dialect, session, schema) as NodeSQLiteDatabase<TSchema> & {
    $client: DatabaseSync;
  };
  db.$client = client;
  return db;
}
