import { Response, NextFunction } from "express";
import { getPool } from "../config/db";
import { AuthRequest } from "../types";

// Chỉ đọc — dùng để frontend hiển thị/tự kiểm tra sơ bộ giới hạn (sĩ số, số giờ...) mà
// KHÔNG phải hard-code số ở phía client. Sửa giá trị thật sự phải qua DB (SchedulingPolicy).
export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT PolicyKey, PolicyValue, Description FROM SchedulingPolicy ORDER BY PolicyKey
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}
