import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface MajorBody {
  majorName?: string;
  trainingMode?: string;
  facultyId?: number;
  isActive?: boolean;
}

function isValidTrainingMode(value: unknown): value is "CQ" | "LT" {
  return value === "CQ" || value === "LT";
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT m.MajorId, m.MajorName, m.TrainingMode, m.FacultyId, f.FacultyName, m.IsActive, m.CreatedAt
      FROM Majors m
      LEFT JOIN Faculties f ON f.FacultyId = m.FacultyId
      ORDER BY m.MajorName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { majorName, trainingMode, facultyId } = req.body as MajorBody;
    if (!majorName) {
      res.status(400).json({ message: "Thiếu tên ngành" });
      return;
    }
    if (!isValidTrainingMode(trainingMode)) {
      res.status(400).json({ message: "Vui lòng chọn hệ đào tạo (Chính quy hoặc Liên thông)" });
      return;
    }
    if (!facultyId) {
      res.status(400).json({ message: "Vui lòng chọn khoa quản lý ngành" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("majorName", sql.NVarChar, majorName)
      .input("trainingMode", sql.NVarChar, trainingMode)
      .input("facultyId", sql.Int, facultyId)
      .query<{ MajorId: number }>(`
        INSERT INTO Majors (MajorName, TrainingMode, FacultyId) OUTPUT INSERTED.MajorId
        VALUES (@majorName, @trainingMode, @facultyId)
      `);
    res.status(201).json({ majorId: result.recordset[0].MajorId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { majorName, trainingMode, facultyId, isActive } = req.body as MajorBody;
    if (!isValidTrainingMode(trainingMode)) {
      res.status(400).json({ message: "Vui lòng chọn hệ đào tạo (Chính quy hoặc Liên thông)" });
      return;
    }
    if (!facultyId) {
      res.status(400).json({ message: "Vui lòng chọn khoa quản lý ngành" });
      return;
    }
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("majorName", sql.NVarChar, majorName)
      .input("trainingMode", sql.NVarChar, trainingMode)
      .input("facultyId", sql.Int, facultyId)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`UPDATE Majors SET MajorName = @majorName, TrainingMode = @trainingMode, FacultyId = @facultyId, IsActive = @isActive WHERE MajorId = @id`);
    res.json({ message: "Đã cập nhật" });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Majors WHERE MajorId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: ngành này đang được sử dụng bởi lớp hoặc môn học khác";
    next(httpErr);
  }
}
