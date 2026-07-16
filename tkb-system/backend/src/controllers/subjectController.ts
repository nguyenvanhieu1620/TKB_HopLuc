import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";
import { runRowInSavepoint, normalizeName } from "../utils/bulkImport";

interface SubjectBody {
  subjectName?: string;
  subjectCode?: string;
  facultyId?: number;
  majorId?: number;
  credits?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  category?: string | null;
  isActive?: boolean;
}

interface BulkSubjectRow {
  subjectCode?: string;
  subjectName?: string;
  facultyId?: number | null;
  majorId?: number | null;
  credits?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  category?: string;
}

const VALID_CATEGORIES = ["DaiCuong", "CoSoNganh", "ChuyenNganh"];

// Phân loại môn theo khối kiến thức (Đại cương/Cơ sở ngành/Chuyên ngành) — dùng để ưu tiên thứ tự xử
// lý môn khi tự động xếp lịch. Rỗng/undefined = chưa phân loại (NULL), hợp lệ; giá trị khác 3 mã
// chuẩn thì từ chối rõ ràng thay vì lưu rác như trước (Category vốn không có CHECK constraint).
function normalizeCategory(category: string | null | undefined): { value: string | null; valid: boolean } {
  if (!category) return { value: null, valid: true };
  if (VALID_CATEGORIES.includes(category)) return { value: category, valid: true };
  return { value: null, valid: false };
}

interface BulkRowResult {
  index: number;
  message: string;
}

interface SubjectBulkResult {
  successCount: number;
  errorCount: number;
  errors: BulkRowResult[];
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { isActive, facultyId, majorId, trainingMode } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();
    let where = "WHERE 1=1";
    if (isActive === "true") where += " AND sub.IsActive = 1";
    else if (isActive === "false") where += " AND sub.IsActive = 0";
    if (facultyId) { request.input("facultyId", sql.Int, facultyId); where += " AND sub.FacultyId = @facultyId"; }
    if (majorId) { request.input("majorId", sql.Int, majorId); where += " AND sub.MajorId = @majorId"; }
    if (trainingMode) { request.input("trainingMode", sql.NVarChar, trainingMode); where += " AND m.TrainingMode = @trainingMode"; }

    const result = await request.query(`
      SELECT sub.SubjectId, sub.SubjectCode, sub.SubjectName, sub.FacultyId, f.FacultyName,
             sub.MajorId, m.MajorName, sub.Category,
             sub.Credits, sub.TheoryHours, sub.PracticeHours, sub.ExamHours, sub.IsActive
      FROM Subjects sub
      LEFT JOIN Faculties f ON f.FacultyId = sub.FacultyId
      LEFT JOIN Majors m ON m.MajorId = sub.MajorId
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
    const { subjectName, subjectCode, facultyId, majorId, credits, theoryHours, practiceHours, examHours, category } =
      req.body as SubjectBody;
    if (!subjectName) {
      res.status(400).json({ message: "Thiếu tên môn học" });
      return;
    }
    if (!majorId) {
      res.status(400).json({ message: "Thiếu ngành — mỗi môn học phải gắn với 1 ngành cụ thể" });
      return;
    }
    if (!subjectCode || !subjectCode.trim()) {
      res.status(400).json({ message: "Thiếu mã môn — mã môn bắt buộc và phải duy nhất" });
      return;
    }
    const categoryResult = normalizeCategory(category);
    if (!categoryResult.valid) {
      res.status(400).json({ message: "Phân loại không hợp lệ" });
      return;
    }

    const pool = await getPool();

    const existing = await pool
      .request()
      .input("subjectCode", sql.NVarChar, subjectCode.trim())
      .query<{ SubjectId: number }>(`SELECT SubjectId FROM Subjects WHERE SubjectCode = @subjectCode`);
    if (existing.recordset[0]) {
      res.status(400).json({ message: "Mã môn đã tồn tại" });
      return;
    }

    const result = await pool
      .request()
      .input("subjectName", sql.NVarChar, subjectName)
      .input("subjectCode", sql.NVarChar, subjectCode.trim())
      .input("facultyId", sql.Int, facultyId || null)
      .input("majorId", sql.Int, majorId)
      .input("credits", sql.Int, credits ?? null)
      .input("theoryHours", sql.Int, theoryHours || 0)
      .input("practiceHours", sql.Int, practiceHours || 0)
      .input("examHours", sql.Int, examHours || 0)
      .input("category", sql.NVarChar, categoryResult.value)
      .query<{ SubjectId: number }>(`
        INSERT INTO Subjects (SubjectName, SubjectCode, FacultyId, MajorId, Credits, TheoryHours, PracticeHours, ExamHours, Category)
        OUTPUT INSERTED.SubjectId
        VALUES (@subjectName, @subjectCode, @facultyId, @majorId, @credits, @theoryHours, @practiceHours, @examHours, @category)
      `);
    res.status(201).json({ subjectId: result.recordset[0].SubjectId });
  } catch (err) {
    const mssqlErr = err as { number?: number };
    if (mssqlErr.number === 2601 || mssqlErr.number === 2627) {
      const httpErr = err as HttpError;
      httpErr.status = 400;
      httpErr.message = "Mã môn đã tồn tại";
      next(httpErr);
      return;
    }
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { subjectName, subjectCode, facultyId, majorId, credits, theoryHours, practiceHours, examHours, category, isActive } =
      req.body as SubjectBody;
    if (!subjectCode || !subjectCode.trim()) {
      res.status(400).json({ message: "Thiếu mã môn — mã môn bắt buộc và phải duy nhất" });
      return;
    }
    const categoryResult = normalizeCategory(category);
    if (!categoryResult.valid) {
      res.status(400).json({ message: "Phân loại không hợp lệ" });
      return;
    }

    const pool = await getPool();

    const existing = await pool
      .request()
      .input("id", sql.Int, id)
      .input("subjectCode", sql.NVarChar, subjectCode.trim())
      .query<{ SubjectId: number }>(`SELECT SubjectId FROM Subjects WHERE SubjectCode = @subjectCode AND SubjectId <> @id`);
    if (existing.recordset[0]) {
      res.status(400).json({ message: "Mã môn đã tồn tại" });
      return;
    }

    await pool
      .request()
      .input("id", sql.Int, id)
      .input("subjectName", sql.NVarChar, subjectName)
      .input("subjectCode", sql.NVarChar, subjectCode.trim())
      .input("facultyId", sql.Int, facultyId || null)
      .input("majorId", sql.Int, majorId || null)
      .input("credits", sql.Int, credits ?? null)
      .input("theoryHours", sql.Int, theoryHours || 0)
      .input("practiceHours", sql.Int, practiceHours || 0)
      .input("examHours", sql.Int, examHours || 0)
      .input("category", sql.NVarChar, categoryResult.value)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Subjects SET SubjectName=@subjectName, SubjectCode=@subjectCode, FacultyId=@facultyId,
          MajorId=@majorId, Credits=@credits, TheoryHours=@theoryHours, PracticeHours=@practiceHours,
          ExamHours=@examHours, Category=@category, IsActive=@isActive
        WHERE SubjectId = @id
      `);
    res.json({ message: "Đã cập nhật" });
  } catch (err) {
    const mssqlErr = err as { number?: number };
    if (mssqlErr.number === 2601 || mssqlErr.number === 2627) {
      const httpErr = err as HttpError;
      httpErr.status = 400;
      httpErr.message = "Mã môn đã tồn tại";
      next(httpErr);
      return;
    }
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

    // Việc AQ: chống trùng theo MÃ MÔN thay vì tên (giờ trùng tên là bình thường — mỗi Ngành có
    // mã riêng theo đúng Thông báo 390/TB-CĐYDHL). Nạp các mã đã có 1 lần, cập nhật dần khi tạo
    // mới trong vòng lặp để bắt được cả trùng NGAY TRONG CÙNG file import.
    const existingResult = await new sql.Request(transaction).query<{ SubjectCode: string }>(
      `SELECT SubjectCode FROM Subjects WHERE SubjectCode IS NOT NULL`
    );
    const existingCodes = new Set(existingResult.recordset.map((r) => normalizeName(r.SubjectCode)));

    const result: SubjectBulkResult = { successCount: 0, errorCount: 0, errors: [] };

    for (let i = 0; i < subjects.length; i++) {
      const row = subjects[i];

      const rowError = await runRowInSavepoint(transaction, i, async (request) => {
        if (!row.subjectName) throw new Error("Thiếu tên môn học");
        if (!row.majorId) throw new Error("Thiếu ngành — mỗi môn học phải gắn với 1 ngành cụ thể");
        if (!row.subjectCode || !row.subjectCode.trim()) throw new Error("Thiếu mã môn — mã môn bắt buộc và phải duy nhất");

        const normalizedCode = normalizeName(row.subjectCode);
        if (existingCodes.has(normalizedCode)) {
          throw new Error(`Mã môn "${row.subjectCode}" đã tồn tại`);
        }

        // Frontend đã validate/chuẩn hóa category trước khi gửi (parseCategory), nhưng backend vẫn tự
        // kiểm tra lại — đây là nguồn duy nhất hiện ghi Category nên không thể chỉ tin tưởng frontend.
        const categoryResult = normalizeCategory(row.category);
        if (!categoryResult.valid) throw new Error(`Phân loại "${row.category}" không hợp lệ`);

        request
          .input("subjectCode", sql.NVarChar, row.subjectCode.trim())
          .input("subjectName", sql.NVarChar, row.subjectName)
          .input("facultyId", sql.Int, row.facultyId ?? null)
          .input("majorId", sql.Int, row.majorId)
          .input("credits", sql.Int, row.credits ?? null)
          .input("theoryHours", sql.Int, row.theoryHours || 0)
          .input("practiceHours", sql.Int, row.practiceHours || 0)
          .input("examHours", sql.Int, row.examHours || 0)
          .input("category", sql.NVarChar, categoryResult.value);
        await request.query(`
          INSERT INTO Subjects (SubjectCode, SubjectName, FacultyId, MajorId, Credits, TheoryHours, PracticeHours, ExamHours, Category)
          VALUES (@subjectCode, @subjectName, @facultyId, @majorId, @credits, @theoryHours, @practiceHours, @examHours, @category)
        `);
        existingCodes.add(normalizedCode);
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
