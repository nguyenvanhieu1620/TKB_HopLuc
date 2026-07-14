import { sql, getPool } from "../config/db";
import { ScheduleConflictResult, ExamConflictResult, ConflictRecord, HolidayRecord } from "../types";

function bindTeacherIds(request: sql.Request, teacherIds: number[]): string {
  return teacherIds
    .map((id, idx) => {
      request.input(`t${idx}`, sql.Int, id);
      return `@t${idx}`;
    })
    .join(", ");
}

async function checkRoomUnavailable(roomId: number, date: string): Promise<ConflictRecord[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("roomId", sql.Int, roomId)
    .input("date", sql.Date, date)
    .query<ConflictRecord>(`
      SELECT UnavailabilityId, RoomId, DateFrom, DateTo, Reason
      FROM RoomUnavailability
      WHERE RoomId = @roomId AND @date BETWEEN DateFrom AND DateTo
    `);
  return result.recordset;
}

async function checkTeacherUnavailable(teacherIds: number[], date: string): Promise<ConflictRecord[]> {
  if (teacherIds.length === 0) return [];
  const pool = await getPool();
  const request = pool.request();
  request.input("date", sql.Date, date);
  const inClause = bindTeacherIds(request, teacherIds);
  const result = await request.query<ConflictRecord>(`
    SELECT tu.UnavailabilityId, tu.TeacherId, t.FullName, tu.DateFrom, tu.DateTo, tu.Reason
    FROM TeacherUnavailability tu
    INNER JOIN Teachers t ON t.TeacherId = tu.TeacherId
    WHERE tu.TeacherId IN (${inClause}) AND @date BETWEEN tu.DateFrom AND tu.DateTo
  `);
  return result.recordset;
}

interface ScheduleConflictParams {
  roomId: number;
  teacherIds?: number[];
  date: string;
  startTime: string;
  endTime: string;
  excludeScheduleId?: number | null;
  // Buổi ghép lớp: các dòng Schedule cùng MergedSessionId cố tình dùng chung
  // phòng/giờ/giảng viên nên KHÔNG được tính là xung đột với nhau.
  excludeMergedSessionId?: number | null;
}

export async function checkScheduleConflict({
  roomId,
  teacherIds = [],
  date,
  startTime,
  endTime,
  excludeScheduleId = null,
  excludeMergedSessionId = null,
}: ScheduleConflictParams): Promise<ScheduleConflictResult> {
  const pool = await getPool();

  const roomReq = pool.request();
  roomReq.input("roomId", sql.Int, roomId);
  roomReq.input("date", sql.Date, date);
  roomReq.input("startTime", sql.VarChar, startTime);
  roomReq.input("endTime", sql.VarChar, endTime);
  roomReq.input("excludeId", sql.Int, excludeScheduleId);
  roomReq.input("excludeMergedId", sql.Int, excludeMergedSessionId);
  const roomResult = await roomReq.query<ConflictRecord>(`
    SELECT s.ScheduleId, s.ClassId, s.SubjectId, s.StartTime, s.EndTime
    FROM Schedule s
    WHERE s.RoomId = @roomId
      AND s.ScheduleDate = @date
      AND s.StartTime < @endTime
      AND s.EndTime > @startTime
      AND (@excludeId IS NULL OR s.ScheduleId <> @excludeId)
      AND (@excludeMergedId IS NULL OR s.MergedSessionId IS NULL OR s.MergedSessionId <> @excludeMergedId)
  `);

  // Kiểm tra chéo với lịch THI: phòng đang có ca thi thì không được xếp lịch học đè lên.
  const examRoomReq = pool.request();
  examRoomReq.input("roomId", sql.Int, roomId);
  examRoomReq.input("date", sql.Date, date);
  examRoomReq.input("startTime", sql.VarChar, startTime);
  examRoomReq.input("endTime", sql.VarChar, endTime);
  const examRoomResult = await examRoomReq.query<ConflictRecord>(`
    SELECT ExamId, ClassId, SubjectId, StartTime, EndTime
    FROM Exams
    WHERE RoomId = @roomId
      AND ExamDate = @date
      AND StartTime < @endTime
      AND EndTime > @startTime
      AND Status <> N'Huy'
  `);

  let teacherResult: { recordset: ConflictRecord[] } = { recordset: [] };
  let examTeacherResult: { recordset: ConflictRecord[] } = { recordset: [] };
  if (teacherIds.length > 0) {
    const teacherReq = pool.request();
    teacherReq.input("date", sql.Date, date);
    teacherReq.input("startTime", sql.VarChar, startTime);
    teacherReq.input("endTime", sql.VarChar, endTime);
    teacherReq.input("excludeId", sql.Int, excludeScheduleId);
    teacherReq.input("excludeMergedId", sql.Int, excludeMergedSessionId);
    const inClause = bindTeacherIds(teacherReq, teacherIds);
    teacherResult = await teacherReq.query<ConflictRecord>(`
      SELECT s.ScheduleId, s.ClassId, s.SubjectId, st.TeacherId, s.StartTime, s.EndTime
      FROM Schedule s
      INNER JOIN ScheduleTeachers st ON st.ScheduleId = s.ScheduleId
      WHERE st.TeacherId IN (${inClause})
        AND s.ScheduleDate = @date
        AND s.StartTime < @endTime
        AND s.EndTime > @startTime
        AND (@excludeId IS NULL OR s.ScheduleId <> @excludeId)
        AND (@excludeMergedId IS NULL OR s.MergedSessionId IS NULL OR s.MergedSessionId <> @excludeMergedId)
    `);

    // Giảng viên đang coi thi cùng khung giờ thì không thể đồng thời được xếp dạy.
    const examTeacherReq = pool.request();
    examTeacherReq.input("date", sql.Date, date);
    examTeacherReq.input("startTime", sql.VarChar, startTime);
    examTeacherReq.input("endTime", sql.VarChar, endTime);
    const inClause2 = bindTeacherIds(examTeacherReq, teacherIds);
    examTeacherResult = await examTeacherReq.query<ConflictRecord>(`
      SELECT e.ExamId, ep.TeacherId, e.StartTime, e.EndTime
      FROM Exams e
      INNER JOIN ExamProctors ep ON ep.ExamId = e.ExamId
      WHERE ep.TeacherId IN (${inClause2})
        AND e.ExamDate = @date
        AND e.StartTime < @endTime
        AND e.EndTime > @startTime
        AND e.Status <> N'Huy'
    `);
  }

  const roomUnavailable = await checkRoomUnavailable(roomId, date);
  const teacherUnavailable = await checkTeacherUnavailable(teacherIds, date);

  const roomConflicts = [...roomResult.recordset, ...examRoomResult.recordset];
  const teacherConflicts = [...teacherResult.recordset, ...examTeacherResult.recordset];

  return {
    hasConflict: roomConflicts.length > 0 || teacherConflicts.length > 0
      || roomUnavailable.length > 0 || teacherUnavailable.length > 0,
    roomConflicts,
    teacherConflicts,
    roomUnavailable,
    teacherUnavailable,
  };
}

interface ExamConflictParams {
  roomId: number;
  proctorIds?: number[];
  date: string;
  startTime: string;
  endTime: string;
  excludeExamId?: number | null;
}

export async function checkExamConflict({
  roomId,
  proctorIds = [],
  date,
  startTime,
  endTime,
  excludeExamId = null,
}: ExamConflictParams): Promise<ExamConflictResult> {
  const pool = await getPool();

  const examRoomReq = pool.request();
  examRoomReq.input("roomId", sql.Int, roomId);
  examRoomReq.input("date", sql.Date, date);
  examRoomReq.input("startTime", sql.VarChar, startTime);
  examRoomReq.input("endTime", sql.VarChar, endTime);
  examRoomReq.input("excludeId", sql.Int, excludeExamId);
  const examRoomResult = await examRoomReq.query<ConflictRecord>(`
    SELECT ExamId, ClassId, SubjectId, StartTime, EndTime
    FROM Exams
    WHERE RoomId = @roomId
      AND ExamDate = @date
      AND StartTime < @endTime
      AND EndTime > @startTime
      AND Status <> N'Huy'
      AND (@excludeId IS NULL OR ExamId <> @excludeId)
  `);

  const schedRoomReq = pool.request();
  schedRoomReq.input("roomId", sql.Int, roomId);
  schedRoomReq.input("date", sql.Date, date);
  schedRoomReq.input("startTime", sql.VarChar, startTime);
  schedRoomReq.input("endTime", sql.VarChar, endTime);
  const schedRoomResult = await schedRoomReq.query<ConflictRecord>(`
    SELECT ScheduleId, ClassId, SubjectId, StartTime, EndTime
    FROM Schedule
    WHERE RoomId = @roomId
      AND ScheduleDate = @date
      AND StartTime < @endTime
      AND EndTime > @startTime
  `);

  let proctorExamResult: { recordset: ConflictRecord[] } = { recordset: [] };
  let proctorSchedResult: { recordset: ConflictRecord[] } = { recordset: [] };
  if (proctorIds.length > 0) {
    const pReq1 = pool.request();
    pReq1.input("date", sql.Date, date);
    pReq1.input("startTime", sql.VarChar, startTime);
    pReq1.input("endTime", sql.VarChar, endTime);
    pReq1.input("excludeId", sql.Int, excludeExamId);
    const inClause1 = bindTeacherIds(pReq1, proctorIds);
    proctorExamResult = await pReq1.query<ConflictRecord>(`
      SELECT e.ExamId, ep.TeacherId, e.StartTime, e.EndTime
      FROM Exams e
      INNER JOIN ExamProctors ep ON ep.ExamId = e.ExamId
      WHERE ep.TeacherId IN (${inClause1})
        AND e.ExamDate = @date
        AND e.StartTime < @endTime
        AND e.EndTime > @startTime
        AND e.Status <> N'Huy'
        AND (@excludeId IS NULL OR e.ExamId <> @excludeId)
    `);

    const pReq2 = pool.request();
    pReq2.input("date", sql.Date, date);
    pReq2.input("startTime", sql.VarChar, startTime);
    pReq2.input("endTime", sql.VarChar, endTime);
    const inClause2 = bindTeacherIds(pReq2, proctorIds);
    proctorSchedResult = await pReq2.query<ConflictRecord>(`
      SELECT s.ScheduleId, st.TeacherId, s.StartTime, s.EndTime
      FROM Schedule s
      INNER JOIN ScheduleTeachers st ON st.ScheduleId = s.ScheduleId
      WHERE st.TeacherId IN (${inClause2})
        AND s.ScheduleDate = @date
        AND s.StartTime < @endTime
        AND s.EndTime > @startTime
    `);
  }

  const roomUnavailable = await checkRoomUnavailable(roomId, date);
  const teacherUnavailable = await checkTeacherUnavailable(proctorIds, date);

  const roomConflicts = [...examRoomResult.recordset, ...schedRoomResult.recordset];
  const proctorConflicts = [...proctorExamResult.recordset, ...proctorSchedResult.recordset];

  const hasConflict = roomConflicts.length > 0 || proctorConflicts.length > 0
    || roomUnavailable.length > 0 || teacherUnavailable.length > 0;

  return {
    hasConflict,
    roomConflicts,
    proctorConflicts,
    roomUnavailable,
    teacherUnavailable,
  };
}

// Cảnh báo (không chặn) khi xếp lịch học/thi vào ngày nghỉ lễ.
// Chỉ báo nếu Holiday áp dụng cho TẤT CẢ, hoặc AppliesTo khớp đúng hệ đào tạo (CQ/LT) của lớp
// đang xếp lịch — vd hệ Liên thông không nghỉ hè nên không cảnh báo với Holiday chỉ áp dụng cho CQ.
export async function findHoliday(date: string, trainingMode?: "CQ" | "LT" | null): Promise<HolidayRecord | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("date", sql.Date, date)
    .input("trainingMode", sql.NVarChar, trainingMode || null)
    .query<HolidayRecord>(`
      SELECT TOP 1 HolidayId, DateFrom, DateTo, Description, AppliesTo
      FROM Holidays
      WHERE @date BETWEEN DateFrom AND DateTo
        AND (AppliesTo = N'ALL' OR (@trainingMode IS NOT NULL AND AppliesTo = @trainingMode))
    `);
  return result.recordset[0] || null;
}

// Việc BG: Cảnh báo (không chặn) khi xếp tiết học thường (không áp dụng cho Exams) vào ngày đã sang
// giai đoạn dành riêng cho thi cuối kỳ (TeachingEndDate của Kỳ đang chọn) — Kỳ thêm thủ công thường
// chưa có TeachingEndDate (NULL) nên không cảnh báo gì.
export async function checkExamPeriodWarning(semesterId: number, scheduleDate: string): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("semesterId", sql.Int, semesterId)
    .query<{ TeachingEndDate: string | null }>(`
      SELECT CONVERT(VARCHAR(10), TeachingEndDate, 23) AS TeachingEndDate FROM Semesters WHERE SemesterId = @semesterId
    `);
  const teachingEndDate = result.recordset[0]?.TeachingEndDate;
  if (!teachingEndDate || scheduleDate <= teachingEndDate) return null;
  return "Ngày này đã sang giai đoạn dành cho thi cuối kỳ, cân nhắc lại nếu đây không phải buổi ôn thi.";
}
