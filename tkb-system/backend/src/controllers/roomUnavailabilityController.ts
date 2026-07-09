import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest } from "../types";

interface RoomUnavailabilityBody {
  roomId?: number;
  dateFrom?: string;
  dateTo?: string;
  reason?: string;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { roomId } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();
    let where = "WHERE 1=1";
    if (roomId) {
      request.input("roomId", sql.Int, roomId);
      where += " AND ru.RoomId = @roomId";
    }
    const result = await request.query(`
      SELECT ru.UnavailabilityId, ru.RoomId, r.RoomName, ru.DateFrom, ru.DateTo, ru.Reason, ru.CreatedAt
      FROM RoomUnavailability ru
      INNER JOIN Rooms r ON r.RoomId = ru.RoomId
      ${where}
      ORDER BY ru.DateFrom DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { roomId, dateFrom, dateTo, reason } = req.body as RoomUnavailabilityBody;
    if (!roomId || !dateFrom || !dateTo) {
      res.status(400).json({ message: "Thiếu phòng hoặc khoảng ngày khóa phòng" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("roomId", sql.Int, roomId)
      .input("dateFrom", sql.Date, dateFrom)
      .input("dateTo", sql.Date, dateTo)
      .input("reason", sql.NVarChar, reason || null)
      .query<{ UnavailabilityId: number }>(`
        INSERT INTO RoomUnavailability (RoomId, DateFrom, DateTo, Reason)
        OUTPUT INSERTED.UnavailabilityId
        VALUES (@roomId, @dateFrom, @dateTo, @reason)
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM RoomUnavailability WHERE UnavailabilityId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    next(err);
  }
}
