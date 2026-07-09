import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";
import { runRowInSavepoint, BulkResult } from "../utils/bulkImport";

interface TeacherBody {
  fullName?: string;
  facultyId?: number;
  positionId?: number;
  phone?: string;
  email?: string;
  isActive?: boolean;
  subjectIds?: number[];
}

interface BulkTeacherRow {
  fullName?: string;
  facultyId?: number | null;
  positionId?: number | null;
  phone?: string;
  email?: string;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT t.TeacherId, t.FullName, t.FacultyId, f.FacultyName, t.PositionId, p.PositionName,
             t.Phone, t.Email, t.IsActive, t.CreatedAt,
             (SELECT STRING_AGG(s.SubjectName, ', ') FROM TeacherSubjects ts
                INNER JOIN Subjects s ON s.SubjectId = ts.SubjectId
                WHERE ts.TeacherId = t.TeacherId) AS Subjects
      FROM Teachers t
      LEFT JOIN Faculties f ON f.FacultyId = t.FacultyId
      LEFT JOIN Positions p ON p.PositionId = t.PositionId
      ORDER BY t.FullName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function getById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const teacher = await pool.request().input("id", sql.Int, id).query(`
      SELECT t.*, f.FacultyName, p.PositionName
      FROM Teachers t
      LEFT JOIN Faculties f ON f.FacultyId = t.FacultyId
      LEFT JOIN Positions p ON p.PositionId = t.PositionId
      WHERE t.TeacherId = @id
    `);
    const subjects = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT s.SubjectId, s.SubjectName
        FROM TeacherSubjects ts
        INNER JOIN Subjects s ON s.SubjectId = ts.SubjectId
        WHERE ts.TeacherId = @id
      `);
    if (!teacher.recordset[0]) {
      res.status(404).json({ message: "Không tìm thấy giảng viên" });
      return;
    }
    res.json({ ...teacher.recordset[0], subjects: subjects.recordset });
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fullName, facultyId, positionId, phone, email, subjectIds = [] } = req.body as TeacherBody;
    if (!fullName) {
      res.status(400).json({ message: "Thiếu họ tên giảng viên" });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("fullName", sql.NVarChar, fullName)
      .input("facultyId", sql.Int, facultyId || null)
      .input("positionId", sql.Int, positionId || null)
      .input("phone", sql.NVarChar, phone || null)
      .input("email", sql.NVarChar, email || null)
      .query<{ TeacherId: number }>(`
        INSERT INTO Teachers (FullName, FacultyId, PositionId, Phone, Email)
        OUTPUT INSERTED.TeacherId
        VALUES (@fullName, @facultyId, @positionId, @phone, @email)
      `);
    const teacherId = result.recordset[0].TeacherId;

    for (const subjectId of subjectIds) {
      await pool
        .request()
        .input("teacherId", sql.Int, teacherId)
        .input("subjectId", sql.Int, subjectId)
        .query(`INSERT INTO TeacherSubjects (TeacherId, SubjectId) VALUES (@teacherId, @subjectId)`);
    }

    res.status(201).json({ teacherId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { fullName, facultyId, positionId, phone, email, isActive, subjectIds = [] } = req.body as TeacherBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("fullName", sql.NVarChar, fullName)
      .input("facultyId", sql.Int, facultyId || null)
      .input("positionId", sql.Int, positionId || null)
      .input("phone", sql.NVarChar, phone || null)
      .input("email", sql.NVarChar, email || null)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Teachers
        SET FullName = @fullName, FacultyId = @facultyId, PositionId = @positionId,
            Phone = @phone, Email = @email, IsActive = @isActive
        WHERE TeacherId = @id
      `);

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM TeacherSubjects WHERE TeacherId = @id`);
    for (const subjectId of subjectIds) {
      await pool
        .request()
        .input("teacherId", sql.Int, id)
        .input("subjectId", sql.Int, subjectId)
        .query(`INSERT INTO TeacherSubjects (TeacherId, SubjectId) VALUES (@teacherId, @subjectId)`);
    }

    res.json({ message: "Đã cập nhật" });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Teachers WHERE TeacherId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: giảng viên này đang có lịch dạy/lịch thi hoặc tài khoản gắn kèm";
    next(httpErr);
  }
}

export async function bulkCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const { teachers } = req.body as { teachers?: BulkTeacherRow[] };
  if (!Array.isArray(teachers) || teachers.length === 0) {
    res.status(400).json({ message: "Danh sách giảng viên trống" });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const result: BulkResult = { successCount: 0, errorCount: 0, errors: [] };

    for (let i = 0; i < teachers.length; i++) {
      const row = teachers[i];
      const rowError = await runRowInSavepoint(transaction, i, async (request) => {
        if (!row.fullName) throw new Error("Thiếu họ tên");
        request
          .input("fullName", sql.NVarChar, row.fullName)
          .input("facultyId", sql.Int, row.facultyId || null)
          .input("positionId", sql.Int, row.positionId || null)
          .input("phone", sql.NVarChar, row.phone || null)
          .input("email", sql.NVarChar, row.email || null);
        await request.query(`
          INSERT INTO Teachers (FullName, FacultyId, PositionId, Phone, Email)
          VALUES (@fullName, @facultyId, @positionId, @phone, @email)
        `);
      });

      if (rowError) {
        result.errorCount++;
        result.errors.push(rowError);
      } else {
        result.successCount++;
      }
    }

    await transaction.commit();
    res.status(201).json(result);
  } catch (err) {
    await transaction.rollback();
    next(err);
  }
}
