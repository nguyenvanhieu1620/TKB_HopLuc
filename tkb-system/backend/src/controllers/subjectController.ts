import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";
import { runRowInSavepoint, normalizeName } from "../utils/bulkImport";

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

interface BulkSubjectRow {
  subjectCode?: string;
  subjectName?: string;
  facultyId?: number | null;
  credits?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  category?: string;
}

interface BulkRowResult {
  index: number;
  message: string;
}

interface SubjectBulkResult {
  successCount: number;
  errorCount: number;
  skippedCount: number;
  errors: BulkRowResult[];
  skipped: BulkRowResult[];
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { isActive } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    let where = "";
    if (isActive === "true") where = "WHERE sub.IsActive = 1";
    else if (isActive === "false") where = "WHERE sub.IsActive = 0";

    const result = await pool.request().query(`
      SELECT sub.SubjectId, sub.SubjectCode, sub.SubjectName, sub.FacultyId, f.FacultyName,
             sub.Credits, sub.TheoryHours, sub.PracticeHours, sub.ExamHours, sub.IsActive
      FROM Subjects sub
      LEFT JOIN Faculties f ON f.FacultyId = sub.FacultyId
      ${where}
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

export async function bulkCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const { subjects } = req.body as { subjects?: BulkSubjectRow[] };
  if (!Array.isArray(subjects) || subjects.length === 0) {
    res.status(400).json({ message: "Danh sách môn học trống" });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    // Nạp tên các môn đã có (chuẩn hóa) để kiểm tra trùng trong bộ nhớ — cần chuẩn hóa khoảng
    // trắng quanh dấu gạch ngang nên không tiện làm thuần bằng SQL như curriculumItemController
    // đang làm (chỉ trim + lower). Cập nhật thêm vào set này khi tạo mới trong vòng lặp, để 2
    // dòng trùng nhau NGAY TRONG CÙNG file import cũng được phát hiện.
    const existingResult = await new sql.Request(transaction).query<{ SubjectName: string }>(
      `SELECT SubjectName FROM Subjects`
    );
    const existingNames = new Set(existingResult.recordset.map((r) => normalizeName(r.SubjectName)));

    const result: SubjectBulkResult = { successCount: 0, errorCount: 0, skippedCount: 0, errors: [], skipped: [] };

    for (let i = 0; i < subjects.length; i++) {
      const row = subjects[i];
      let skippedDuplicate = false;

      const rowError = await runRowInSavepoint(transaction, i, async (request) => {
        if (!row.subjectName) throw new Error("Thiếu tên môn học");

        const normalized = normalizeName(row.subjectName);
        if (existingNames.has(normalized)) {
          skippedDuplicate = true;
          return;
        }

        request
          .input("subjectCode", sql.NVarChar, row.subjectCode || null)
          .input("subjectName", sql.NVarChar, row.subjectName)
          .input("facultyId", sql.Int, row.facultyId ?? null)
          .input("credits", sql.Int, row.credits ?? null)
          .input("theoryHours", sql.Int, row.theoryHours || 0)
          .input("practiceHours", sql.Int, row.practiceHours || 0)
          .input("examHours", sql.Int, row.examHours || 0)
          .input("category", sql.NVarChar, row.category || null);
        await request.query(`
          INSERT INTO Subjects (SubjectCode, SubjectName, FacultyId, Credits, TheoryHours, PracticeHours, ExamHours, Category)
          VALUES (@subjectCode, @subjectName, @facultyId, @credits, @theoryHours, @practiceHours, @examHours, @category)
        `);
        existingNames.add(normalized);
      });

      if (rowError) {
        result.errorCount++;
        result.errors.push(rowError);
      } else if (skippedDuplicate) {
        result.skippedCount++;
        result.skipped.push({ index: i, message: "Môn học đã tồn tại — bỏ qua" });
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
