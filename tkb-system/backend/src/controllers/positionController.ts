import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface PositionBody {
  positionName?: string;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT PositionId, PositionName, IsActive FROM Positions ORDER BY PositionName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { positionName } = req.body as PositionBody;
    if (!positionName) {
      res.status(400).json({ message: "Thiếu tên chức vụ" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("positionName", sql.NVarChar, positionName)
      .query<{ PositionId: number }>(`
        INSERT INTO Positions (PositionName)
        OUTPUT INSERTED.PositionId
        VALUES (@positionName)
      `);
    res.status(201).json({ positionId: result.recordset[0].PositionId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { positionName, isActive } = req.body as PositionBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("positionName", sql.NVarChar, positionName)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Positions SET PositionName=@positionName, IsActive=@isActive
        WHERE PositionId = @id
      `);
    res.json({ message: "Đã cập nhật" });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Positions WHERE PositionId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: chức vụ này đang được gán cho giảng viên";
    next(httpErr);
  }
}
