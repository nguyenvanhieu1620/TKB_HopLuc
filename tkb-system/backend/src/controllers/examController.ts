import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { checkExamConflict, findHoliday } from "../utils/conflictCheck";
import { getClassMajorTrainingMode } from "../utils/trainingModeCheck";
import { getPolicyValue } from "../utils/policyConfig";
import { getTotalPeriodsForSubject, getPeriodTimelineForSubject } from "../utils/policyRules";
import { writeAuditLog } from "../utils/auditLog";
import { notifyTeachers } from "../utils/notify";
import { AuthRequest } from "../types";

async function getClassSubjectNames(classId: number, subjectId: number): Promise<{ className: string; subjectName: string } | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("subjectId", sql.Int, subjectId)
    .query<{ ClassName: string; SubjectName: string }>(`
      SELECT (SELECT ClassName FROM Classes WHERE ClassId = @classId) AS ClassName,
             (SELECT SubjectName FROM Subjects WHERE SubjectId = @subjectId) AS SubjectName
    `);
  const row = result.recordset[0];
  if (!row || !row.ClassName || !row.SubjectName) return null;
  return { className: row.ClassName, subjectName: row.SubjectName };
}

function conflictMessage(conflict: { roomUnavailable: unknown[]; teacherUnavailable: unknown[] }): string {
  if (conflict.roomUnavailable.length > 0) {
    return "Phòng đang tạm khóa/bảo trì trong ngày này, không thể xếp lịch thi";
  }
  if (conflict.teacherUnavailable.length > 0) {
    return "Giám thị đã báo bận trong ngày này, không thể xếp lịch coi thi";
  }
  return "Phát hiện xung đột lịch thi (trùng phòng thi, trùng giám thị, hoặc trùng lịch giảng dạy)";
}

interface ExamBody {
  semesterId?: number;
  classId?: number;
  subjectId?: number;
  roomId?: number;
  proctorIds?: number[];
  examDate?: string;
  startTime?: string;
  endTime?: string;
  examType?: string;
  status?: string;
  note?: string;
}

// Việc BI: thêm cohortId/from/to (khớp đúng cách GET /schedule đã hỗ trợ) để ScheduleGrid.tsx gộp
// hiển thị Lịch thi cùng Thời khóa biểu ở cả 2 chế độ xem — "Theo kỳ" (semesterId/classId có sẵn từ
// trước) và "Tất cả các lớp" (cần thêm cohortId + khoảng ngày).
export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId, classId, cohortId, teacherId, from, to } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();

    let where = "WHERE 1=1";
    if (semesterId) { request.input("semesterId", sql.Int, semesterId); where += " AND e.SemesterId=@semesterId"; }
    if (classId) { request.input("classId", sql.Int, classId); where += " AND e.ClassId=@classId"; }
    if (cohortId) { request.input("cohortId", sql.Int, cohortId); where += " AND c.CohortId=@cohortId"; }
    if (from) { request.input("from", sql.Date, from); where += " AND e.ExamDate>=@from"; }
    if (to) { request.input("to", sql.Date, to); where += " AND e.ExamDate<=@to"; }
    if (teacherId) {
      request.input("teacherId", sql.Int, teacherId);
      where += " AND EXISTS (SELECT 1 FROM ExamProctors ep WHERE ep.ExamId=e.ExamId AND ep.TeacherId=@teacherId)";
    }

    const result = await request.query(`
      SELECT e.ExamId, e.SemesterId, e.ClassId, c.ClassName, e.SubjectId, sub.SubjectName,
             e.RoomId, r.RoomName, e.ExamDate,
             CONVERT(VARCHAR(5), e.StartTime, 108) AS StartTime,
             CONVERT(VARCHAR(5), e.EndTime, 108) AS EndTime,
             e.ExamType, e.Status, e.Note,
             (SELECT STRING_AGG(t.FullName, ' / ') FROM ExamProctors ep
                INNER JOIN Teachers t ON t.TeacherId = ep.TeacherId
                WHERE ep.ExamId = e.ExamId) AS Proctors
      FROM Exams e
      INNER JOIN Classes c ON c.ClassId = e.ClassId
      INNER JOIN Subjects sub ON sub.SubjectId = e.SubjectId
      INNER JOIN Rooms r ON r.RoomId = e.RoomId
      ${where}
      ORDER BY e.ExamDate, e.StartTime
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

// Việc CB: chi tiết 1 ca thi để phục vụ form Sửa ngay trong ScheduleGrid.tsx — list() chỉ trả
// Proctors dạng CHUỖI tên gộp (STRING_AGG), không đủ để tự chọn sẵn đúng giám thị trong multi-select
// khi mở form Sửa (đối chiếu lại theo tên không đáng tin cậy nếu trùng tên) — trả thêm ProctorIds
// dạng mảng số, cùng pattern GET /schedule/:id đã dùng cho teacherIds của buổi học thường.
export async function getById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT e.ExamId, e.SemesterId, e.ClassId, c.ClassName, e.SubjectId, sub.SubjectName,
             e.RoomId, r.RoomName,
             CONVERT(VARCHAR(10), e.ExamDate, 23) AS ExamDate,
             CONVERT(VARCHAR(5), e.StartTime, 108) AS StartTime,
             CONVERT(VARCHAR(5), e.EndTime, 108) AS EndTime,
             e.ExamType, e.Status, e.Note
      FROM Exams e
      INNER JOIN Classes c ON c.ClassId = e.ClassId
      INNER JOIN Subjects sub ON sub.SubjectId = e.SubjectId
      INNER JOIN Rooms r ON r.RoomId = e.RoomId
      WHERE e.ExamId = @id
    `);
    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ message: "Không tìm thấy ca thi" });
      return;
    }

    const proctorResult = await pool.request().input("id", sql.Int, id).query<{ TeacherId: number }>(
      `SELECT TeacherId FROM ExamProctors WHERE ExamId = @id`
    );
    res.json({ ...row, ProctorIds: proctorResult.recordset.map((p) => p.TeacherId) });
  } catch (err) {
    next(err);
  }
}

// LTHI-02: 1 Lớp+Môn chỉ "đủ điều kiện thi" khi đã xếp ĐỦ CẢ HAI — số tiết Lý thuyết đạt chỉ tiêu
// VÀ số tiết Thực hành đạt chỉ tiêu (Việc AV — trước đây gộp chung 1 tổng nên báo nhầm đủ điều
// kiện dù toàn bộ giờ đã xếp đều là Lý thuyết, chưa xếp phút Thực hành nào, hoặc ngược lại).
export async function eligible(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId } = req.query as Record<string, string | undefined>;
    const pool = await getPool();

    const rowsResult = await pool
      .request()
      .input("semesterId", sql.Int, semesterId)
      .query<{
        ClassId: number; ClassName: string; MajorId: number; CohortId: number | null;
        SubjectId: number; SubjectName: string; TermNumber: number | null;
      }>(`
        SELECT DISTINCT c.ClassId, c.ClassName, c.MajorId, c.CohortId, s.SubjectId, sub.SubjectName, sem.TermNumber
        FROM Schedule s
        INNER JOIN Classes c ON c.ClassId = s.ClassId
        INNER JOIN Subjects sub ON sub.SubjectId = s.SubjectId
        LEFT JOIN Semesters sem ON sem.SemesterId = s.SemesterId
        WHERE s.SemesterId = @semesterId
      `);

    const result = await Promise.all(
      rowsResult.recordset.map(async (row) => {
        const [targets, timeline, examResult] = await Promise.all([
          getTotalPeriodsForSubject(row.MajorId, row.SubjectId, row.CohortId, row.TermNumber),
          getPeriodTimelineForSubject(row.ClassId, row.SubjectId),
          pool
            .request()
            .input("classId", sql.Int, row.ClassId)
            .input("subjectId", sql.Int, row.SubjectId)
            .input("semesterId", sql.Int, semesterId)
            .query<{ Count: number }>(
              `SELECT COUNT(*) AS Count FROM Exams WHERE ClassId=@classId AND SubjectId=@subjectId AND SemesterId=@semesterId`
            ),
        ]);
        // Việc BB: timeline nay có thể lặp lại cùng 1 giá trị lũy kế cho nhiều dòng (các nhóm tách
        // ra từ 1 lần groupedCreate dùng chung kết quả của dòng đại diện) và dòng cuối mảng KHÔNG
        // còn chắc là dòng có Ngày muộn nhất (1 nhóm có thể tự chọn Ngày muộn hơn dòng đại diện của
        // chính lô đó) — lấy MAX thay vì phần tử cuối để luôn ra đúng tổng lũy kế cao nhất thực tế.
        const theoryDone = timeline.reduce((max, t) => Math.max(max, t.cumulativeTheoryPeriods), 0);
        const practiceDone = timeline.reduce((max, t) => Math.max(max, t.cumulativePracticePeriods), 0);
        return {
          ClassId: row.ClassId,
          ClassName: row.ClassName,
          SubjectId: row.SubjectId,
          SubjectName: row.SubjectName,
          TheoryDone: theoryDone,
          TheoryTarget: targets.theoryTarget,
          PracticeDone: practiceDone,
          PracticeTarget: targets.practiceTarget,
          DuDieuKienThi: theoryDone >= targets.theoryTarget && practiceDone >= targets.practiceTarget,
          DaXepLichThi: examResult.recordset[0].Count > 0,
        };
      })
    );

    result.sort((a, b) => a.ClassName.localeCompare(b.ClassName) || a.SubjectName.localeCompare(b.SubjectName));
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classId, subjectId, roomId, proctorIds = [],
      examDate, startTime, endTime, examType, note,
    } = req.body as ExamBody;

    if (!semesterId || !classId || !subjectId || !roomId || !examDate || !startTime || !endTime) {
      res.status(400).json({ message: "Thiếu thông tin bắt buộc để xếp lịch thi" });
      return;
    }

    const minProctors = await getPolicyValue("MinProctorsPerExam");
    if (proctorIds.length < minProctors) {
      res.status(400).json({ message: `Cần tối thiểu ${minProctors} giám thị cho mỗi phòng thi` });
      return;
    }

    const conflict = await checkExamConflict({
      roomId, proctorIds, date: examDate, startTime, endTime,
    });
    if (conflict.hasConflict) {
      res.status(409).json({ message: conflictMessage(conflict), conflict });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("semesterId", sql.Int, semesterId)
      .input("classId", sql.Int, classId)
      .input("subjectId", sql.Int, subjectId)
      .input("roomId", sql.Int, roomId)
      .input("examDate", sql.Date, examDate)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("examType", sql.NVarChar, examType || "TuLuan")
      .input("note", sql.NVarChar, note || null)
      .input("createdBy", sql.Int, req.user!.userId)
      .query<{ ExamId: number }>(`
        INSERT INTO Exams (SemesterId, ClassId, SubjectId, RoomId, ExamDate, StartTime, EndTime, ExamType, Note, CreatedBy)
        OUTPUT INSERTED.ExamId
        VALUES (@semesterId, @classId, @subjectId, @roomId, @examDate, @startTime, @endTime, @examType, @note, @createdBy)
      `);
    const examId = result.recordset[0].ExamId;

    for (const teacherId of proctorIds) {
      await pool
        .request()
        .input("examId", sql.Int, examId)
        .input("teacherId", sql.Int, teacherId)
        .query(`INSERT INTO ExamProctors (ExamId, TeacherId) VALUES (@examId, @teacherId)`);
    }

    await writeAuditLog({ userId: req.user!.userId, action: "Insert", tableName: "Exams", recordId: examId, detail: req.body });

    if (proctorIds.length > 0) {
      const names = await getClassSubjectNames(classId, subjectId);
      if (names) {
        await notifyTeachers(
          proctorIds,
          `Lịch coi thi mới: Lớp ${names.className} - ${names.subjectName}, ngày ${examDate} (${startTime}-${endTime})`,
          "Exam",
          examId
        );
      }
    }

    // Việc CA: Lịch nghỉ tính theo hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride).
    const majorClassInfo = await getClassMajorTrainingMode(classId);
    const holiday = await findHoliday(examDate, majorClassInfo?.trainingMode);
    res.status(201).json({
      examId,
      warning: holiday ? `Ngày ${examDate} rơi vào ngày nghỉ lễ: ${holiday.Description}` : undefined,
    });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const {
      classId, subjectId, roomId, proctorIds = [],
      examDate, startTime, endTime, examType, status, note,
    } = req.body as ExamBody;

    const minProctors = await getPolicyValue("MinProctorsPerExam");
    if (proctorIds.length < minProctors) {
      res.status(400).json({ message: `Cần tối thiểu ${minProctors} giám thị cho mỗi phòng thi` });
      return;
    }

    const conflict = await checkExamConflict({
      roomId: roomId as number, proctorIds, date: examDate as string,
      startTime: startTime as string, endTime: endTime as string, excludeExamId: Number(id),
    });
    if (conflict.hasConflict) {
      res.status(409).json({ message: conflictMessage(conflict), conflict });
      return;
    }

    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("classId", sql.Int, classId)
      .input("subjectId", sql.Int, subjectId)
      .input("roomId", sql.Int, roomId)
      .input("examDate", sql.Date, examDate)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("examType", sql.NVarChar, examType || "TuLuan")
      .input("status", sql.NVarChar, status || "ChuaThi")
      .input("note", sql.NVarChar, note || null)
      .query(`
        UPDATE Exams SET ClassId=@classId, SubjectId=@subjectId, RoomId=@roomId,
          ExamDate=@examDate, StartTime=@startTime, EndTime=@endTime,
          ExamType=@examType, Status=@status, Note=@note, UpdatedAt=SYSDATETIME()
        WHERE ExamId=@id
      `);

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM ExamProctors WHERE ExamId=@id`);
    for (const teacherId of proctorIds) {
      await pool
        .request()
        .input("examId", sql.Int, id)
        .input("teacherId", sql.Int, teacherId)
        .query(`INSERT INTO ExamProctors (ExamId, TeacherId) VALUES (@examId, @teacherId)`);
    }

    await writeAuditLog({ userId: req.user!.userId, action: "Update", tableName: "Exams", recordId: Number(id), detail: req.body });

    if (proctorIds.length > 0) {
      const names = await getClassSubjectNames(classId as number, subjectId as number);
      if (names) {
        await notifyTeachers(
          proctorIds,
          `Lịch coi thi đã thay đổi: Lớp ${names.className} - ${names.subjectName}, ngày ${examDate} (${startTime}-${endTime})`,
          "Exam",
          Number(id)
        );
      }
    }

    // Việc CA: Lịch nghỉ tính theo hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride).
    const majorClassInfo = await getClassMajorTrainingMode(classId as number);
    const holiday = await findHoliday(examDate as string, majorClassInfo?.trainingMode);
    res.json({
      message: "Đã cập nhật lịch thi",
      warning: holiday ? `Ngày ${examDate} rơi vào ngày nghỉ lễ: ${holiday.Description}` : undefined,
    });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();

    // Lấy thông tin ca thi + giám thị liên quan TRƯỚC khi xóa, vì sau DELETE sẽ không còn truy vấn được.
    const infoResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{
        ClassName: string; SubjectName: string; ExamDate: string; StartTime: string; EndTime: string;
      }>(`
        SELECT c.ClassName, sub.SubjectName,
               CONVERT(VARCHAR(10), e.ExamDate, 23) AS ExamDate,
               CONVERT(VARCHAR(5), e.StartTime, 108) AS StartTime,
               CONVERT(VARCHAR(5), e.EndTime, 108) AS EndTime
        FROM Exams e
        INNER JOIN Classes c ON c.ClassId = e.ClassId
        INNER JOIN Subjects sub ON sub.SubjectId = e.SubjectId
        WHERE e.ExamId = @id
      `);
    const info = infoResult.recordset[0];
    const proctorResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{ TeacherId: number }>(`SELECT TeacherId FROM ExamProctors WHERE ExamId = @id`);
    const proctorIds = proctorResult.recordset.map((t) => t.TeacherId);

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Exams WHERE ExamId=@id`);
    await writeAuditLog({ userId: req.user!.userId, action: "Delete", tableName: "Exams", recordId: Number(id) });

    if (info && proctorIds.length > 0) {
      await notifyTeachers(
        proctorIds,
        `Lịch coi thi đã bị hủy: Lớp ${info.ClassName} - ${info.SubjectName}, ngày ${info.ExamDate} (${info.StartTime}-${info.EndTime})`,
        "Exam",
        Number(id)
      );
    }

    res.json({ message: "Đã xóa lịch thi" });
  } catch (err) {
    next(err);
  }
}
