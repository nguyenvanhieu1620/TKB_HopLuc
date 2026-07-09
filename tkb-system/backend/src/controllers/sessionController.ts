import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface SessionBody {
  sessionName?: string;
  startTime?: string;
  endTime?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT SessionId, SessionName,
             CONVERT(VARCHAR(5), StartTime, 108) AS StartTime,
             CONVERT(VARCHAR(5), EndTime, 108) AS EndTime,
             SortOrder, IsActive
      FROM Sessions ORDER BY SortOrder
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { sessionName, startTime, endTime, sortOrder } = req.body as SessionBody;
    if (!sessionName || !startTime || !endTime) {
      res.status(400).json({ message: "Thiếu thông tin ca học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("sessionName", sql.NVarChar, sessionName)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("sortOrder", sql.Int, sortOrder ?? null)
      .query<{ SessionId: number }>(`
        INSERT INTO Sessions (SessionName, StartTime, EndTime, SortOrder)
        OUTPUT INSERTED.SessionId
        VALUES (@sessionName, @startTime, @endTime,
                COALESCE(@sortOrder, (SELECT ISNULL(MAX(SortOrder), 0) + 1 FROM Sessions)))
      `);
    res.status(201).json({ sessionId: result.recordset[0].SessionId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { sessionName, startTime, endTime, sortOrder, isActive } = req.body as SessionBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("sessionName", sql.NVarChar, sessionName)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("sortOrder", sql.Int, sortOrder)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Sessions SET SessionName=@sessionName,
          StartTime=@startTime, EndTime=@endTime, SortOrder=@sortOrder, IsActive=@isActive
        WHERE SessionId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Sessions WHERE SessionId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: ca học này đang được tham chiếu";
    next(httpErr);
  }
}
