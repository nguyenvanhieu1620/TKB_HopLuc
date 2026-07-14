import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface SemesterBody {
  semesterName?: string;
  academicYear?: string;
  startDate?: string;
  endDate?: string;
  // Việc BG: hạn cuối xếp tiết học thường — để trống (NULL) với Kỳ thêm thủ công, không bắt buộc.
  teachingEndDate?: string | null;
  classId?: number;
  termNumber?: number;
  isActive?: boolean;
}

// Mỗi Lớp có bộ Kỳ học riêng (trường tuyển sinh quanh năm, không dùng chung 1 danh mục Học kỳ
// cho nhiều lớp) — bắt buộc lọc theo classId, không cho lấy toàn bộ Semesters không phân biệt lớp.
export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId } = req.query as Record<string, string | undefined>;
    if (!classId) {
      res.status(400).json({ message: "Thiếu classId — mỗi lớp có bộ Kỳ học riêng" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("classId", sql.Int, classId)
      .query(`
        SELECT SemesterId, SemesterName, AcademicYear, StartDate, EndDate, TeachingEndDate, ClassId, TermNumber, IsActive
        FROM Semesters WHERE ClassId = @classId
        ORDER BY TermNumber, StartDate
      `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterName, academicYear, startDate, endDate, teachingEndDate, classId, termNumber } = req.body as SemesterBody;
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
      .input("teachingEndDate", sql.Date, teachingEndDate || null)
      .input("classId", sql.Int, classId ?? null)
      .input("termNumber", sql.Int, termNumber ?? null)
      .query<{ SemesterId: number }>(`
        INSERT INTO Semesters (SemesterName, AcademicYear, StartDate, EndDate, TeachingEndDate, ClassId, TermNumber)
        OUTPUT INSERTED.SemesterId
        VALUES (@semesterName, @academicYear, @startDate, @endDate, @teachingEndDate, @classId, @termNumber)
      `);
    res.status(201).json({ semesterId: result.recordset[0].SemesterId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { semesterName, academicYear, startDate, endDate, teachingEndDate, classId, termNumber, isActive } = req.body as SemesterBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("semesterName", sql.NVarChar, semesterName)
      .input("academicYear", sql.NVarChar, academicYear)
      .input("startDate", sql.Date, startDate)
      .input("endDate", sql.Date, endDate)
      .input("teachingEndDate", sql.Date, teachingEndDate || null)
      .input("classId", sql.Int, classId ?? null)
      .input("termNumber", sql.Int, termNumber ?? null)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Semesters SET SemesterName=@semesterName, AcademicYear=@academicYear,
          StartDate=@startDate, EndDate=@endDate, TeachingEndDate=@teachingEndDate,
          ClassId=@classId, TermNumber=@termNumber, IsActive=@isActive
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
