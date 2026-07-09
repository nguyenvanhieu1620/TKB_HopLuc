import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface SemesterBody {
  semesterName?: string;
  academicYear?: string;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT SemesterId, SemesterName, AcademicYear, StartDate, EndDate, IsActive
      FROM Semesters ORDER BY StartDate DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterName, academicYear, startDate, endDate } = req.body as SemesterBody;
    if (!semesterName || !academicYear || !startDate || !endDate) {
      res.status(400).json({ message: "Thiếu thông tin đợt học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("semesterName", sql.NVarChar, semesterName)
      .input("academicYear", sql.NVarChar, academicYear)
      .input("startDate", sql.Date, startDate)
      .input("endDate", sql.Date, endDate)
      .query<{ SemesterId: number }>(`
        INSERT INTO Semesters (SemesterName, AcademicYear, StartDate, EndDate)
        OUTPUT INSERTED.SemesterId
        VALUES (@semesterName, @academicYear, @startDate, @endDate)
      `);
    res.status(201).json({ semesterId: result.recordset[0].SemesterId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { semesterName, academicYear, startDate, endDate, isActive } = req.body as SemesterBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("semesterName", sql.NVarChar, semesterName)
      .input("academicYear", sql.NVarChar, academicYear)
      .input("startDate", sql.Date, startDate)
      .input("endDate", sql.Date, endDate)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Semesters SET SemesterName=@semesterName, AcademicYear=@academicYear,
          StartDate=@startDate, EndDate=@endDate, IsActive=@isActive
        WHERE SemesterId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Semesters WHERE SemesterId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: đợt học này đang có lịch học/lịch thi";
    next(httpErr);
  }
}
