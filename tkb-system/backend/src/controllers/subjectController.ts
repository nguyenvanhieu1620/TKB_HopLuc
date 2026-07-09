import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface SubjectBody {
  subjectName?: string;
  subjectCode?: string;
  facultyId?: number;
  credits?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  isActive?: boolean;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT sub.SubjectId, sub.SubjectCode, sub.SubjectName, sub.FacultyId, f.FacultyName,
             sub.Credits, sub.TheoryHours, sub.PracticeHours, sub.ExamHours, sub.IsActive
      FROM Subjects sub
      LEFT JOIN Faculties f ON f.FacultyId = sub.FacultyId
      ORDER BY sub.SubjectName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { subjectName, subjectCode, facultyId, credits, theoryHours, practiceHours, examHours } =
      req.body as SubjectBody;
    if (!subjectName) {
      res.status(400).json({ message: "Thiếu tên môn học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("subjectName", sql.NVarChar, subjectName)
      .input("subjectCode", sql.NVarChar, subjectCode || null)
      .input("facultyId", sql.Int, facultyId || null)
      .input("credits", sql.Int, credits ?? null)
      .input("theoryHours", sql.Int, theoryHours || 0)
      .input("practiceHours", sql.Int, practiceHours || 0)
      .input("examHours", sql.Int, examHours || 0)
      .query<{ SubjectId: number }>(`
        INSERT INTO Subjects (SubjectName, SubjectCode, FacultyId, Credits, TheoryHours, PracticeHours, ExamHours)
        OUTPUT INSERTED.SubjectId
        VALUES (@subjectName, @subjectCode, @facultyId, @credits, @theoryHours, @practiceHours, @examHours)
      `);
    res.status(201).json({ subjectId: result.recordset[0].SubjectId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { subjectName, subjectCode, facultyId, credits, theoryHours, practiceHours, examHours, isActive } =
      req.body as SubjectBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("subjectName", sql.NVarChar, subjectName)
      .input("subjectCode", sql.NVarChar, subjectCode || null)
      .input("facultyId", sql.Int, facultyId || null)
      .input("credits", sql.Int, credits ?? null)
      .input("theoryHours", sql.Int, theoryHours || 0)
      .input("practiceHours", sql.Int, practiceHours || 0)
      .input("examHours", sql.Int, examHours || 0)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Subjects SET SubjectName=@subjectName, SubjectCode=@subjectCode, FacultyId=@facultyId,
          Credits=@credits, TheoryHours=@theoryHours, PracticeHours=@practiceHours, ExamHours=@examHours,
          IsActive=@isActive
        WHERE SubjectId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Subjects WHERE SubjectId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: môn học này đang được sử dụng trong lịch học/lịch thi/khung chương trình";
    next(httpErr);
  }
}
