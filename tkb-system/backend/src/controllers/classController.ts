import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface ClassBody {
  className?: string;
  majorId?: number;
  cohortId?: number;
  classSize?: number;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT c.ClassId, c.ClassName, c.MajorId, m.MajorName, m.TrainingMode,
             c.CohortId, co.CohortName, c.ClassSize, c.IsActive
      FROM Classes c
      INNER JOIN Majors m ON m.MajorId = c.MajorId
      INNER JOIN Cohorts co ON co.CohortId = c.CohortId
      ORDER BY co.CohortName, c.ClassName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { className, majorId, cohortId, classSize } = req.body as ClassBody;
    if (!className || !majorId || !cohortId) {
      res.status(400).json({ message: "Thiếu tên lớp, ngành hoặc khóa học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("className", sql.NVarChar, className)
      .input("majorId", sql.Int, majorId)
      .input("cohortId", sql.Int, cohortId)
      .input("classSize", sql.Int, classSize || 0)
      .query<{ ClassId: number }>(`
        INSERT INTO Classes (ClassName, MajorId, CohortId, ClassSize)
        OUTPUT INSERTED.ClassId
        VALUES (@className, @majorId, @cohortId, @classSize)
      `);
    res.status(201).json({ classId: result.recordset[0].ClassId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { className, majorId, cohortId, classSize, isActive } = req.body as ClassBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("className", sql.NVarChar, className)
      .input("majorId", sql.Int, majorId)
      .input("cohortId", sql.Int, cohortId)
      .input("classSize", sql.Int, classSize || 0)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Classes SET ClassName=@className, MajorId=@majorId,
          CohortId=@cohortId, ClassSize=@classSize, IsActive=@isActive
        WHERE ClassId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Classes WHERE ClassId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: lớp này đang có lịch học/lịch thi";
    next(httpErr);
  }
}
