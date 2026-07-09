import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface RoomBody {
  roomName?: string;
  roomType?: string;
  capacity?: number;
  facultyId?: number;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT r.RoomId, r.RoomName, r.RoomType, r.Capacity, r.FacultyId, f.FacultyName, r.IsActive
      FROM Rooms r
      LEFT JOIN Faculties f ON f.FacultyId = r.FacultyId
      ORDER BY r.RoomName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { roomName, roomType, capacity, facultyId } = req.body as RoomBody;
    if (!roomName) {
      res.status(400).json({ message: "Thiếu tên phòng" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("roomName", sql.NVarChar, roomName)
      .input("roomType", sql.NVarChar, roomType || "LyThuyet")
      .input("capacity", sql.Int, capacity || null)
      .input("facultyId", sql.Int, facultyId || null)
      .query<{ RoomId: number }>(`
        INSERT INTO Rooms (RoomName, RoomType, Capacity, FacultyId)
        OUTPUT INSERTED.RoomId
        VALUES (@roomName, @roomType, @capacity, @facultyId)
      `);
    res.status(201).json({ roomId: result.recordset[0].RoomId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { roomName, roomType, capacity, facultyId, isActive } = req.body as RoomBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("roomName", sql.NVarChar, roomName)
      .input("roomType", sql.NVarChar, roomType || "LyThuyet")
      .input("capacity", sql.Int, capacity || null)
      .input("facultyId", sql.Int, facultyId || null)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Rooms SET RoomName=@roomName, RoomType=@roomType,
          Capacity=@capacity, FacultyId=@facultyId, IsActive=@isActive
        WHERE RoomId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Rooms WHERE RoomId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: phòng này đang được dùng trong lịch học/lịch thi";
    next(httpErr);
  }
}
