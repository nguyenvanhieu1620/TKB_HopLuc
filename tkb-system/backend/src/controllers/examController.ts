import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { checkExamConflict, findHoliday } from "../utils/conflictCheck";
import { getClassTrainingMode } from "../utils/trainingModeCheck";
import { getPolicyValue } from "../utils/policyConfig";
import { writeAuditLog } from "../utils/auditLog";
import { AuthRequest } from "../types";

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

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId, classId, teacherId } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();

    let where = "WHERE 1=1";
    if (semesterId) { request.input("semesterId", sql.Int, semesterId); where += " AND e.SemesterId=@semesterId"; }
    if (classId) { request.input("classId", sql.Int, classId); where += " AND e.ClassId=@classId"; }
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

export async function eligible(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const result = await pool
      .request()
      .input("semesterId", sql.Int, semesterId)
      .query(`
        SELECT c.ClassId, c.ClassName, sub.SubjectId, sub.SubjectName,
               (sub.TheoryHours + sub.PracticeHours) AS TotalPeriods,
               COUNT(s.ScheduleId) AS SoTietDaXep,
               CASE WHEN EXISTS (
                 SELECT 1 FROM Exams e WHERE e.ClassId = c.ClassId AND e.SubjectId = sub.SubjectId
                   AND e.SemesterId = @semesterId
               ) THEN 1 ELSE 0 END AS DaXepLichThi
        FROM Classes c
        INNER JOIN CurriculumItems ci ON ci.MajorId = c.MajorId AND ci.IsActive = 1
        INNER JOIN Subjects sub ON sub.SubjectId = ci.SubjectId
        LEFT JOIN Schedule s ON s.ClassId = c.ClassId AND s.SubjectId = sub.SubjectId AND s.SemesterId = @semesterId
        GROUP BY c.ClassId, c.ClassName, sub.SubjectId, sub.SubjectName, sub.TheoryHours, sub.PracticeHours
        HAVING COUNT(s.ScheduleId) > 0
        ORDER BY c.ClassName, sub.SubjectName
      `);
    res.json(result.recordset);
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

    const classInfo = await getClassTrainingMode(classId);
    const holiday = await findHoliday(examDate, classInfo?.trainingMode);
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

    const classInfo = await getClassTrainingMode(classId as number);
    const holiday = await findHoliday(examDate as string, classInfo?.trainingMode);
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Exams WHERE ExamId=@id`);
    await writeAuditLog({ userId: req.user!.userId, action: "Delete", tableName: "Exams", recordId: Number(id) });
    res.json({ message: "Đã xóa lịch thi" });
  } catch (err) {
    next(err);
  }
}
