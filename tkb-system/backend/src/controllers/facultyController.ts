import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface FacultyBody {
  facultyName?: string;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT FacultyId, FacultyName, IsActive FROM Faculties ORDER BY FacultyName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { facultyName } = req.body as FacultyBody;
    if (!facultyName) {
      res.status(400).json({ message: "Thiếu tên khoa" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("facultyName", sql.NVarChar, facultyName)
      .query<{ FacultyId: number }>(`
        INSERT INTO Faculties (FacultyName)
        OUTPUT INSERTED.FacultyId
        VALUES (@facultyName)
      `);
    res.status(201).json({ facultyId: result.recordset[0].FacultyId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { facultyName, isActive } = req.body as FacultyBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("facultyName", sql.NVarChar, facultyName)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Faculties SET FacultyName=@facultyName, IsActive=@isActive
        WHERE FacultyId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Faculties WHERE FacultyId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: khoa này đang có giảng viên hoặc môn học trực thuộc";
    next(httpErr);
  }
}
