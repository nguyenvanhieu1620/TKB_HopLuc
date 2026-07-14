import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { getPolicyValue } from "../utils/policyConfig";
import { AuthRequest, HttpError } from "../types";

interface ClassBody {
  className?: string;
  majorId?: number;
  cohortId?: number;
  classSize?: number;
  startDate?: string;
  isActive?: boolean;
  schedulePatternOverride?: "CQ" | "LT" | null;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT c.ClassId, c.ClassName, c.MajorId, m.MajorName, m.TrainingMode,
             c.SchedulePatternOverride,
             c.CohortId, co.CohortName, c.ClassSize, c.StartDate, c.IsActive
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
    const { className, majorId, cohortId, classSize, startDate, schedulePatternOverride } = req.body as ClassBody;
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
      .input("startDate", sql.Date, startDate || null)
      .input("schedulePatternOverride", sql.NVarChar, schedulePatternOverride || null)
      .query<{ ClassId: number }>(`
        INSERT INTO Classes (ClassName, MajorId, CohortId, ClassSize, StartDate, SchedulePatternOverride)
        OUTPUT INSERTED.ClassId
        VALUES (@className, @majorId, @cohortId, @classSize, @startDate, @schedulePatternOverride)
      `);
    res.status(201).json({ classId: result.recordset[0].ClassId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { className, majorId, cohortId, classSize, startDate, isActive, schedulePatternOverride } = req.body as ClassBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("className", sql.NVarChar, className)
      .input("majorId", sql.Int, majorId)
      .input("cohortId", sql.Int, cohortId)
      .input("classSize", sql.Int, classSize || 0)
      .input("startDate", sql.Date, startDate || null)
      .input("isActive", sql.Bit, isActive ?? true)
      .input("schedulePatternOverride", sql.NVarChar, schedulePatternOverride || null)
      .query(`
        UPDATE Classes SET ClassName=@className, MajorId=@majorId,
          CohortId=@cohortId, ClassSize=@classSize, StartDate=@startDate, IsActive=@isActive,
          SchedulePatternOverride=@schedulePatternOverride
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

// YYYY-MM-DD + offset ngày -> YYYY-MM-DD mới, tính theo UTC để tránh lệch múi giờ server
// (cùng cách làm với shiftDateStr trong scheduleController.ts).
function shiftDateStr(dateStr: string, offsetDays: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// Năm học kiểu VN (vd '2026-2027') suy từ ngày bắt đầu — quy ước năm học bắt đầu từ tháng 7.
function academicYearOf(dateStr: string): string {
  const [y, m] = dateStr.slice(0, 10).split("-").map(Number);
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

interface GenerateTermsBody {
  force?: boolean;
}

// Việc AC: tự động sinh các Kỳ nối tiếp nhau cho 1 lớp, tính từ đúng ngày khai giảng của lớp đó
// (KHÔNG dùng chung 1 bộ Kỳ cho nhiều lớp — mỗi lớp khai giảng 1 thời điểm khác nhau).
export async function generateTerms(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { force } = req.body as GenerateTermsBody;
    const pool = await getPool();

    const classResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{ ClassId: number; ClassName: string; MajorId: number; StartDate: string | null }>(`
        SELECT ClassId, ClassName, MajorId, CONVERT(VARCHAR(10), StartDate, 23) AS StartDate
        FROM Classes WHERE ClassId = @id
      `);
    const cls = classResult.recordset[0];
    if (!cls) {
      res.status(404).json({ message: "Không tìm thấy lớp" });
      return;
    }
    if (!cls.StartDate) {
      res.status(400).json({ message: "Lớp này chưa có ngày khai giảng — vui lòng cập nhật trước khi tạo Kỳ học" });
      return;
    }

    const majorResult = await pool
      .request()
      .input("majorId", sql.Int, cls.MajorId)
      .query<{ TrainingMode: "CQ" | "LT" | null }>(`SELECT TrainingMode FROM Majors WHERE MajorId = @majorId`);
    const trainingMode = majorResult.recordset[0]?.TrainingMode;
    if (!trainingMode) {
      res.status(400).json({ message: "Ngành của lớp chưa xác định hệ đào tạo (CQ/LT)" });
      return;
    }

    const existing = await pool
      .request()
      .input("classId", sql.Int, id)
      .query<{ SemesterId: number }>(`SELECT SemesterId FROM Semesters WHERE ClassId = @classId`);

    if (existing.recordset.length > 0) {
      if (!force) {
        res.status(400).json({
          message: `Lớp này đã có ${existing.recordset.length} kỳ học được tạo trước đó — dùng tùy chọn "Xóa hết và tạo lại" nếu cần làm lại`,
        });
        return;
      }
      try {
        await pool.request().input("classId", sql.Int, id).query(`DELETE FROM Semesters WHERE ClassId = @classId`);
      } catch (delErr) {
        const httpErr = delErr as HttpError;
        httpErr.status = 409;
        httpErr.message = "Không thể xóa lại: một số kỳ học của lớp này đang có lịch học/lịch thi";
        next(httpErr);
        return;
      }
    }

    const totalTermsKey = trainingMode === "CQ" ? "TotalTermsCQ" : "TotalTermsLT";
    const weeksPerTermKey = trainingMode === "CQ" ? "MinWeeksPerSemesterCQ" : "MinWeeksPerSemesterLT";
    const totalTerms = await getPolicyValue(totalTermsKey);
    const weeksPerTerm = await getPolicyValue(weeksPerTermKey);
    // Việc BG: dành riêng ExamPeriodWeeks tuần cuối mỗi Kỳ cho thi — TeachingEndDate = EndDate trừ
    // đi đúng số ngày đó, không xếp tiết học thường sau mốc này (chỉ cảnh báo, không chặn cứng).
    const examPeriodWeeks = await getPolicyValue("ExamPeriodWeeks");

    const created: {
      semesterId: number; termNumber: number; semesterName: string; startDate: string; endDate: string; teachingEndDate: string;
    }[] = [];
    let cursor = cls.StartDate;
    for (let term = 1; term <= totalTerms; term++) {
      const startDate = cursor;
      const endDate = shiftDateStr(startDate, weeksPerTerm * 7 - 1);
      const teachingEndDate = shiftDateStr(endDate, -(examPeriodWeeks * 7));
      const semesterName = `Kỳ ${term} - ${cls.ClassName}`;
      const academicYear = academicYearOf(startDate);

      const result = await pool
        .request()
        .input("semesterName", sql.NVarChar, semesterName)
        .input("academicYear", sql.NVarChar, academicYear)
        .input("startDate", sql.Date, startDate)
        .input("endDate", sql.Date, endDate)
        .input("teachingEndDate", sql.Date, teachingEndDate)
        .input("classId", sql.Int, id)
        .input("termNumber", sql.Int, term)
        .query<{ SemesterId: number }>(`
          INSERT INTO Semesters (SemesterName, AcademicYear, StartDate, EndDate, TeachingEndDate, ClassId, TermNumber)
          OUTPUT INSERTED.SemesterId
          VALUES (@semesterName, @academicYear, @startDate, @endDate, @teachingEndDate, @classId, @termNumber)
        `);
      created.push({
        semesterId: result.recordset[0].SemesterId, termNumber: term, semesterName, startDate, endDate, teachingEndDate,
      });

      cursor = shiftDateStr(endDate, 1);
    }

    res.status(201).json({ terms: created });
  } catch (err) {
    next(err);
  }
}
