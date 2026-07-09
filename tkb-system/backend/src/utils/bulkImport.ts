import { sql } from "../config/db";

export interface BulkRowError {
  index: number;
  message: string;
}

export interface BulkResult {
  successCount: number;
  errorCount: number;
  errors: BulkRowError[];
}

// Chạy 1 hàng trong 1 SAVEPOINT bên trong transaction chung: nếu hàng đó lỗi thì chỉ
// rollback riêng hàng đó (không mất các hàng đã insert thành công trước đó), rồi tiếp tục.
export async function runRowInSavepoint(
  transaction: sql.Transaction,
  index: number,
  fn: (request: sql.Request) => Promise<void>
): Promise<BulkRowError | null> {
  const savepoint = `sp_${index}`;
  await new sql.Request(transaction).query(`SAVE TRANSACTION ${savepoint}`);
  try {
    await fn(new sql.Request(transaction));
    return null;
  } catch (err) {
    await new sql.Request(transaction).query(`ROLLBACK TRANSACTION ${savepoint}`);
    const message = err instanceof Error ? err.message : "Lỗi không xác định";
    return { index, message };
  }
}
