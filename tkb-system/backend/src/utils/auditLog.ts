import { sql, getPool } from "../config/db";
import { AuditLogInput } from "../types";

export async function writeAuditLog({ userId, action, tableName, recordId, detail }: AuditLogInput): Promise<void> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("userId", sql.Int, userId ?? null)
      .input("action", sql.NVarChar, action)
      .input("tableName", sql.NVarChar, tableName)
      .input("recordId", sql.Int, recordId ?? null)
      .input("detail", sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
      .query(`
        INSERT INTO AuditLog (UserId, Action, TableName, RecordId, Detail)
        VALUES (@userId, @action, @tableName, @recordId, @detail)
      `);
  } catch (err) {
    console.error("Ghi audit log thất bại:", (err as Error).message);
  }
}
