import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";
import { runRowInSavepoint, normalizeName, BulkResult } from "../utils/bulkImport";

interface CurriculumItemBody {
  majorId?: number;
  subjectId?: number;
  termNumber?: number;
  credits?: number;
  totalHours?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  cohortId?: number;
  sortOrder?: number;
  isActive?: boolean;
  practiceMode?: "LyThuyet" | "ThucHanh" | "LamSang";
}

interface BulkCurriculumRow {
  majorId?: number;
  cohortId?: number | null;
  subjectCode?: string;
  subjectName?: string;
  credits?: number;
  totalHours?: number;
  theoryHours?: number;
  practiceHours?: number;
  examHours?: number;
  termNumber?: number;
  practiceMode?: "LyThuyet" | "ThucHanh" | "LamSang";
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { majorId, cohortId, termNumber } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();
    let where = "WHERE 1=1";
    if (majorId) {
      request.input("majorId", sql.Int, majorId);
      where += " AND ci.MajorId = @majorId";
    }
    if (termNumber) {
      request.input("termNumber", sql.Int, termNumber);
      where += " AND ci.TermNumber = @termNumber";
    }

    // Có lọc theo Khóa: 1 môn/kỳ có thể có 1 dòng áp dụng chung (CohortId NULL) và 1 dòng ghi đè
    // riêng cho đúng khóa đang xem — chỉ lấy 1 trong 2 (ưu tiên dòng ghi đè riêng nếu có) để không
    // hiện đúp cùng 1 môn 2 lần trong bảng khung chương trình của khóa đó.
    if (cohortId) {
      request.input("cohortId", sql.Int, cohortId);
      where += " AND (ci.CohortId = @cohortId OR ci.CohortId IS NULL)";

      const result = await request.query(`
        WITH ranked AS (
          SELECT ci.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY ci.SubjectId, ci.TermNumber
                   ORDER BY CASE WHEN ci.CohortId = @cohortId THEN 0 ELSE 1 END
                 ) AS rn
          FROM CurriculumItems ci
          ${where}
        )
        SELECT ci.CurriculumItemId, ci.MajorId, m.MajorName, ci.SubjectId, sub.SubjectName, sub.SubjectCode,
               ci.CohortId, co.CohortName, ci.TermNumber, COALESCE(ci.Credits, sub.Credits) AS Credits,
               COALESCE(ci.TotalHours, sub.TheoryHours + sub.PracticeHours + sub.ExamHours) AS TotalHours,
               COALESCE(ci.TheoryHours, sub.TheoryHours) AS TheoryHours,
               COALESCE(ci.PracticeHours, sub.PracticeHours) AS PracticeHours,
               COALESCE(ci.ExamHours, sub.ExamHours) AS ExamHours,
               ci.PracticeMode, ci.SortOrder, ci.IsActive
        FROM ranked ci
        INNER JOIN Majors m ON m.MajorId = ci.MajorId
        INNER JOIN Subjects sub ON sub.SubjectId = ci.SubjectId
        LEFT JOIN Cohorts co ON co.CohortId = ci.CohortId
        WHERE ci.rn = 1
        ORDER BY m.MajorName, ci.TermNumber, ci.SortOrder
      `);
      res.json(result.recordset);
      return;
    }

    const result = await request.query(`
      SELECT ci.CurriculumItemId, ci.MajorId, m.MajorName, ci.SubjectId, sub.SubjectName, sub.SubjectCode,
             ci.CohortId, co.CohortName, ci.TermNumber, COALESCE(ci.Credits, sub.Credits) AS Credits,
             COALESCE(ci.TotalHours, sub.TheoryHours + sub.PracticeHours + sub.ExamHours) AS TotalHours,
             COALESCE(ci.TheoryHours, sub.TheoryHours) AS TheoryHours,
             COALESCE(ci.PracticeHours, sub.PracticeHours) AS PracticeHours,
             COALESCE(ci.ExamHours, sub.ExamHours) AS ExamHours,
             ci.PracticeMode, ci.SortOrder, ci.IsActive
      FROM CurriculumItems ci
      INNER JOIN Majors m ON m.MajorId = ci.MajorId
      INNER JOIN Subjects sub ON sub.SubjectId = ci.SubjectId
      LEFT JOIN Cohorts co ON co.CohortId = ci.CohortId
      ${where}
      ORDER BY m.MajorName, ci.TermNumber, ci.SortOrder
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      majorId, subjectId, termNumber, credits,
      totalHours, theoryHours, practiceHours, examHours, cohortId, sortOrder, practiceMode,
    } = req.body as CurriculumItemBody;
    if (!majorId || !subjectId || !termNumber) {
      res.status(400).json({ message: "Thiếu ngành, môn học hoặc kỳ học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("majorId", sql.Int, majorId)
      .input("subjectId", sql.Int, subjectId)
      .input("termNumber", sql.Int, termNumber)
      .input("credits", sql.Int, credits ?? null)
      .input("totalHours", sql.Int, totalHours ?? null)
      .input("theoryHours", sql.Int, theoryHours ?? null)
      .input("practiceHours", sql.Int, practiceHours ?? null)
      .input("examHours", sql.Int, examHours ?? null)
      .input("cohortId", sql.Int, cohortId ?? null)
      .input("sortOrder", sql.Int, sortOrder ?? 0)
      .input("practiceMode", sql.NVarChar, practiceMode || "ThucHanh")
      .query<{ CurriculumItemId: number }>(`
        INSERT INTO CurriculumItems
          (MajorId, SubjectId, TermNumber, Credits, TotalHours, TheoryHours, PracticeHours, ExamHours, CohortId, SortOrder, PracticeMode)
        OUTPUT INSERTED.CurriculumItemId
        VALUES (@majorId, @subjectId, @termNumber, @credits, @totalHours, @theoryHours, @practiceHours, @examHours, @cohortId, @sortOrder, @practiceMode)
      `);
    res.status(201).json({ curriculumItemId: result.recordset[0].CurriculumItemId });
  } catch (err) {
    const mssqlErr = err as { number?: number };
    if (mssqlErr.number === 2627) {
      const httpErr = err as HttpError;
      httpErr.status = 409;
      httpErr.message = "Môn học này đã có trong khung chương trình của ngành";
      next(httpErr);
      return;
    }
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const {
      termNumber, credits, totalHours, theoryHours, practiceHours, examHours, cohortId, sortOrder, isActive, practiceMode,
    } = req.body as CurriculumItemBody;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("termNumber", sql.Int, termNumber)
      .input("credits", sql.Int, credits ?? null)
      .input("totalHours", sql.Int, totalHours ?? null)
      .input("theoryHours", sql.Int, theoryHours ?? null)
      .input("practiceHours", sql.Int, practiceHours ?? null)
      .input("examHours", sql.Int, examHours ?? null)
      .input("cohortId", sql.Int, cohortId ?? null)
      .input("sortOrder", sql.Int, sortOrder ?? 0)
      .input("isActive", sql.Bit, isActive ?? true)
      .input("practiceMode", sql.NVarChar, practiceMode || "ThucHanh")
      .query(`
        UPDATE CurriculumItems SET TermNumber=@termNumber, Credits=@credits,
          TotalHours=@totalHours, TheoryHours=@theoryHours, PracticeHours=@practiceHours, ExamHours=@examHours,
          CohortId=@cohortId, SortOrder=@sortOrder, IsActive=@isActive, PracticeMode=@practiceMode
        WHERE CurriculumItemId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM CurriculumItems WHERE CurriculumItemId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    next(err);
  }
}

export async function bulkCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const { items } = req.body as { items?: BulkCurriculumRow[] };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: "Danh sách khung chương trình trống" });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const result: BulkResult = { successCount: 0, errorCount: 0, errors: [] };

    // Nạp map tên môn đã chuẩn hóa -> SubjectId 1 lần, cập nhật dần khi tạo môn mới trong vòng
    // lặp — để 2 dòng cùng tên môn MỚI trong cùng file import link về đúng 1 Subject thay vì tạo
    // đôi. Dùng normalizeName dùng chung (Việc AI/AN) thay vì chỉ trim+lower như trước, để khớp
    // đúng cả khi tên môn chỉ khác nhau về khoảng trắng/loại dấu gạch ngang.
    const existingResult = await new sql.Request(transaction).query<{ SubjectId: number; SubjectName: string }>(
      `SELECT SubjectId, SubjectName FROM Subjects`
    );
    const subjectIdByNormalizedName = new Map<string, number>(
      existingResult.recordset.map((r) => [normalizeName(r.SubjectName), r.SubjectId])
    );

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      const rowError = await runRowInSavepoint(transaction, i, async () => {
        if (!row.majorId || !row.subjectCode || !row.subjectName || !row.termNumber) {
          throw new Error("Thiếu ngành, mã môn, tên môn hoặc kỳ học");
        }

        const normalized = normalizeName(row.subjectName);
        let subjectId = subjectIdByNormalizedName.get(normalized);
        if (subjectId === undefined) {
          const inserted = await new sql.Request(transaction)
            .input("subjectCode", sql.NVarChar, row.subjectCode)
            .input("subjectName", sql.NVarChar, row.subjectName)
            .input("credits", sql.Int, row.credits ?? null)
            .input("theoryHours", sql.Int, row.theoryHours || 0)
            .input("practiceHours", sql.Int, row.practiceHours || 0)
            .input("examHours", sql.Int, row.examHours || 0)
            .query<{ SubjectId: number }>(`
              INSERT INTO Subjects (SubjectCode, SubjectName, Credits, TheoryHours, PracticeHours, ExamHours)
              OUTPUT INSERTED.SubjectId
              VALUES (@subjectCode, @subjectName, @credits, @theoryHours, @practiceHours, @examHours)
            `);
          subjectId = inserted.recordset[0].SubjectId;
          subjectIdByNormalizedName.set(normalized, subjectId);
        }

        await new sql.Request(transaction)
          .input("majorId", sql.Int, row.majorId)
          .input("cohortId", sql.Int, row.cohortId ?? null)
          .input("subjectId", sql.Int, subjectId)
          .input("termNumber", sql.Int, row.termNumber)
          .input("credits", sql.Int, row.credits ?? null)
          .input("totalHours", sql.Int, row.totalHours ?? null)
          .input("theoryHours", sql.Int, row.theoryHours ?? null)
          .input("practiceHours", sql.Int, row.practiceHours ?? null)
          .input("examHours", sql.Int, row.examHours ?? null)
          .input("practiceMode", sql.NVarChar, row.practiceMode || "ThucHanh")
          .query(`
            INSERT INTO CurriculumItems
              (MajorId, CohortId, SubjectId, TermNumber, Credits, TotalHours, TheoryHours, PracticeHours, ExamHours, SortOrder, PracticeMode)
            VALUES
              (@majorId, @cohortId, @subjectId, @termNumber, @credits, @totalHours, @theoryHours, @practiceHours, @examHours, 0, @practiceMode)
          `);
      });

      if (rowError) {
        if (rowError.message.includes("UQ_CurriculumItems")) {
          rowError.message = "Môn học này đã có trong khung chương trình của ngành ở kỳ này";
        }
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
