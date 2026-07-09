import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest } from "../types";

interface TeacherUnavailabilityBody {
  teacherId?: number;
  dateFrom?: string;
  dateTo?: string;
  reason?: string;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teacherId } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();
    let where = "WHERE 1=1";
    if (teacherId) {
      request.input("teacherId", sql.Int, teacherId);
      where += " AND tu.TeacherId = @teacherId";
    }
    const result = await request.query(`
      SELECT tu.UnavailabilityId, tu.TeacherId, t.FullName, tu.DateFrom, tu.DateTo, tu.Reason, tu.CreatedAt
      FROM TeacherUnavailability tu
      INNER JOIN Teachers t ON t.TeacherId = tu.TeacherId
      ${where}
      ORDER BY tu.DateFrom DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teacherId, dateFrom, dateTo, reason } = req.body as TeacherUnavailabilityBody;
    if (!teacherId || !dateFrom || !dateTo) {
      res.status(400).json({ message: "Thiếu giảng viên hoặc khoảng ngày báo bận" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("teacherId", sql.Int, teacherId)
      .input("dateFrom", sql.Date, dateFrom)
      .input("dateTo", sql.Date, dateTo)
      .input("reason", sql.NVarChar, reason || null)
      .query<{ UnavailabilityId: number }>(`
        INSERT INTO TeacherUnavailability (TeacherId, DateFrom, DateTo, Reason)
        OUTPUT INSERTED.UnavailabilityId
        VALUES (@teacherId, @dateFrom, @dateTo, @reason)
      `);
    res.status(201).json({ unavailabilityId: result.recordset[0].UnavailabilityId });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM TeacherUnavailability WHERE UnavailabilityId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    next(err);
  }
}
