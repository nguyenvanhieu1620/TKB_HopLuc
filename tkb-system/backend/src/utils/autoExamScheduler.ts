import { randomUUID } from "crypto";
import { sql, getPool } from "../config/db";
import { HttpError } from "../types";
import { getPolicyValue } from "./policyConfig";
import { getSubjectRoomIds } from "./policyRules";
import { checkExamConflict, findHoliday } from "./conflictCheck";
import { getClassMajorTrainingMode, getClassTrainingMode, getWeekday, classifyPeriod } from "./trainingModeCheck";
import { shiftDateStr, addMinutesToTime } from "./autoScheduler";
import { getEligibleExamSubjects } from "../controllers/examController";
import { writeAuditLog } from "./auditLog";
import { notifyTeachers } from "./notify";

export interface AutoExamScheduleSubjectResult {
  subjectId: number;
  subjectName: string;
  isComplete: boolean;
  examId?: number;
  examDate?: string;
  startTime?: string;
  endTime?: string;
  roomId?: number;
  proctorIds?: number[];
  failureReason?: string;
}

export interface AutoExamScheduleReport {
  autoScheduleRunId: string;
  subjectResults: AutoExamScheduleSubjectResult[];
}

interface RoomRow { RoomId: number; RoomType: string; }
interface SessionRow { SessionId: number; StartTime: string; EndTime: string; SortOrder: number; }
interface DateSessionSlot { date: string; session: SessionRow; }

// Việc CC (cập nhật): thứ tự/phạm vi (Ngày, Ca) khả dụng để xếp LỊCH THI — ràng buộc RIÊNG cho Lịch
// thi, KHÁC với ràng buộc ngày/buổi của tiết học thường (checkTrainingModeRule/buildDateSessionSlots
// trong autoScheduler.ts). Dùng Hệ HIỆU LỰC (getClassTrainingMode — ưu tiên SchedulePatternOverride,
// fallback Majors.TrainingMode), giống cách xác định hệ để chọn ngày/buổi cho tiết học thường.
// - Liên thông: CHỈ Thứ 7/CN (Sáng+Chiều, mọi tuần trong vùng thi) — ưu tiên cao nhất; hết chỗ mới
//   dùng thêm Thứ 6 (cũng chỉ Sáng+Chiều). KHÔNG BAO GIỜ dùng Ca Tối cho lịch thi (dù Ca Tối vẫn hợp
//   lệ cho tiết học thường của hệ này), và KHÔNG dùng Thứ 2-5.
// - Chính quy (hoặc chưa xác định hệ): CHỈ Thứ 2-6, Sáng hoặc Chiều, không Tối — theo thứ tự ngày tăng
//   dần bình thường trong vùng thi.
function buildExamDateSessionSlots(examDates: string[], sessions: SessionRow[], trainingMode: "CQ" | "LT" | null): DateSessionSlot[] {
  const nonToiSessions = sessions.filter((s) => classifyPeriod(s.StartTime) !== "Toi");

  if (trainingMode === "LT") {
    const satSunDates = examDates.filter((d) => [0, 6].includes(getWeekday(d)));
    const friDates = examDates.filter((d) => getWeekday(d) === 5);
    return [
      ...satSunDates.flatMap((date) => nonToiSessions.map((session) => ({ date, session }))),
      ...friDates.flatMap((date) => nonToiSessions.map((session) => ({ date, session }))),
    ];
  }

  const monFriDates = examDates.filter((d) => { const wd = getWeekday(d); return wd >= 1 && wd <= 5; });
  return monFriDates.flatMap((date) => nonToiSessions.map((session) => ({ date, session })));
}

// Việc CC: checkExamConflict (conflictCheck.ts) không kiểm tra trùng theo Lớp (2 ca thi của CÙNG 1
// Lớp chồng giờ nhau) — bổ sung kiểm tra riêng ở đây, đối chiếu cả Exams lẫn Schedule của đúng Lớp.
async function isClassSlotOccupied(classId: number, date: string, startTime: string, endTime: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("date", sql.Date, date)
    .input("startTime", sql.VarChar, startTime)
    .input("endTime", sql.VarChar, endTime)
    .query<{ Id: number }>(`
      SELECT ExamId AS Id FROM Exams
      WHERE ClassId = @classId AND ExamDate = @date AND StartTime < @endTime AND EndTime > @startTime AND Status <> N'Huy'
      UNION ALL
      SELECT ScheduleId AS Id FROM Schedule
      WHERE ClassId = @classId AND ScheduleDate = @date AND StartTime < @endTime AND EndTime > @startTime
    `);
  return result.recordset.length > 0;
}

// Tìm mọi Giảng viên đang active KHÔNG bận đúng khung giờ này (cả Schedule lẫn Exams) và không nghỉ
// (TeacherUnavailability) — không cần dạy đúng môn, chỉ cần đang rảnh là đủ điều kiện làm giám thị.
async function findFreeProctorIds(date: string, startTime: string, endTime: string): Promise<number[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("date", sql.Date, date)
    .input("startTime", sql.VarChar, startTime)
    .input("endTime", sql.VarChar, endTime)
    .query<{ TeacherId: number }>(`
      SELECT t.TeacherId FROM Teachers t
      WHERE t.IsActive = 1
        AND NOT EXISTS (
          SELECT 1 FROM ScheduleTeachers st INNER JOIN Schedule s ON s.ScheduleId = st.ScheduleId
          WHERE st.TeacherId = t.TeacherId AND s.ScheduleDate = @date AND s.StartTime < @endTime AND s.EndTime > @startTime
        )
        AND NOT EXISTS (
          SELECT 1 FROM ExamProctors ep INNER JOIN Exams e ON e.ExamId = ep.ExamId
          WHERE ep.TeacherId = t.TeacherId AND e.ExamDate = @date AND e.StartTime < @endTime AND e.EndTime > @startTime AND e.Status <> N'Huy'
        )
        AND NOT EXISTS (
          SELECT 1 FROM TeacherUnavailability tu WHERE tu.TeacherId = t.TeacherId AND @date BETWEEN tu.DateFrom AND tu.DateTo
        )
    `);
  return result.recordset.map((r) => r.TeacherId);
}

interface ExamHoursAndMode { examHours: number; practiceMode: string; }

// Cùng pattern COALESCE(CurriculumItems.X, Subjects.X) ưu tiên dòng khớp CohortId đã dùng ở
// getTotalPeriodsForSubject (policyRules.ts) — nhưng lấy ExamHours + PracticeMode, KHÔNG lấy
// Theory/PracticeHours (những cái đó không cần cho lịch thi). Subjects không có cột PracticeMode nên
// khi môn chưa có dòng CurriculumItems nào, mặc định "ThucHanh" (khác LamSang) để rơi vào nhánh phòng
// Lý thuyết theo đúng quy tắc đã chốt, không suy đoán Lâm sàng.
async function getExamHoursAndMode(
  majorId: number, subjectId: number, cohortId: number | null, termNumber: number | null
): Promise<ExamHoursAndMode> {
  const pool = await getPool();
  if (termNumber != null) {
    const ciResult = await pool
      .request()
      .input("majorId", sql.Int, majorId)
      .input("subjectId", sql.Int, subjectId)
      .input("termNumber", sql.Int, termNumber)
      .input("cohortId", sql.Int, cohortId)
      .query<{ ExamHours: number | null; PracticeMode: string }>(`
        SELECT TOP 1 COALESCE(ci.ExamHours, sub.ExamHours) AS ExamHours, ci.PracticeMode AS PracticeMode
        FROM CurriculumItems ci
        INNER JOIN Subjects sub ON sub.SubjectId = ci.SubjectId
        WHERE ci.MajorId = @majorId AND ci.SubjectId = @subjectId AND ci.TermNumber = @termNumber
          AND (ci.CohortId = @cohortId OR ci.CohortId IS NULL)
        ORDER BY CASE WHEN ci.CohortId = @cohortId THEN 0 ELSE 1 END
      `);
    const row = ciResult.recordset[0];
    if (row) return { examHours: row.ExamHours ?? 0, practiceMode: row.PracticeMode };
  }
  const subResult = await pool
    .request()
    .input("subjectId", sql.Int, subjectId)
    .query<{ ExamHours: number }>(`SELECT ExamHours FROM Subjects WHERE SubjectId = @subjectId`);
  return { examHours: subResult.recordset[0]?.ExamHours ?? 0, practiceMode: "ThucHanh" };
}

export async function runAutoScheduleExams(classId: number, semesterId: number, userId: number): Promise<AutoExamScheduleReport> {
  const pool = await getPool();

  const classResult = await pool
    .request()
    .input("classId", sql.Int, classId)
    .query<{ MajorId: number; CohortId: number | null; ClassSize: number }>(
      `SELECT MajorId, CohortId, ClassSize FROM Classes WHERE ClassId = @classId`
    );
  const cls = classResult.recordset[0];
  if (!cls) {
    const err: HttpError = new Error("Không tìm thấy lớp");
    err.status = 404;
    throw err;
  }

  const semesterResult = await pool
    .request()
    .input("semesterId", sql.Int, semesterId)
    .input("classId", sql.Int, classId)
    .query<{ EndDate: string; TeachingEndDate: string | null; TermNumber: number | null }>(`
      SELECT CONVERT(VARCHAR(10), EndDate, 23) AS EndDate,
             CONVERT(VARCHAR(10), TeachingEndDate, 23) AS TeachingEndDate, TermNumber
      FROM Semesters WHERE SemesterId = @semesterId AND ClassId = @classId
    `);
  const semester = semesterResult.recordset[0];
  if (!semester) {
    const err: HttpError = new Error("Không tìm thấy Kỳ học thuộc đúng Lớp này");
    err.status = 400;
    throw err;
  }
  if (!semester.TeachingEndDate) {
    const err: HttpError = new Error("Kỳ này chưa có Ngày kết thúc dạy học (TeachingEndDate) — không thể xác định vùng thi");
    err.status = 400;
    throw err;
  }

  // Việc BG: vùng thi = NGAY SAU TeachingEndDate đến hết EndDate của Kỳ.
  const examRangeStart = shiftDateStr(semester.TeachingEndDate, 1);
  const examRangeEnd = semester.EndDate;
  if (examRangeStart > examRangeEnd) {
    const err: HttpError = new Error("Kỳ này không còn vùng thi (Ngày kết thúc dạy học đã sát hoặc vượt Ngày kết thúc Kỳ)");
    err.status = 400;
    throw err;
  }
  const examDates: string[] = [];
  for (let d = examRangeStart; d <= examRangeEnd; d = shiftDateStr(d, 1)) examDates.push(d);

  // Việc CC: findHoliday dùng Hệ GỐC của Ngành (majorClassInfo, KHÔNG qua SchedulePatternOverride) —
  // trong khi thứ tự/phạm vi (Ngày, Ca) khả dụng dùng Hệ HIỆU LỰC (classInfo, ưu tiên override) — 2
  // mục đích độc lập, đúng nguyên tắc đã tách ở Việc CA cho tiết học thường.
  const majorClassInfo = await getClassMajorTrainingMode(classId);
  const classInfo = await getClassTrainingMode(classId);

  const sessionsResult = await pool.request().query<SessionRow>(`
    SELECT SessionId, CONVERT(VARCHAR(5), StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), EndTime, 108) AS EndTime, SortOrder
    FROM Sessions WHERE IsActive = 1 ORDER BY SortOrder
  `);
  const sessions = sessionsResult.recordset;
  const roomsResult = await pool.request().query<RoomRow>(`SELECT RoomId, RoomType FROM Rooms WHERE IsActive = 1`);
  const rooms = roomsResult.recordset;

  const dateSessionSlots = buildExamDateSessionSlots(examDates, sessions, classInfo?.trainingMode ?? null);
  const availableDateCount = new Set(dateSessionSlots.map((s) => s.date)).size;
  if (availableDateCount === 0) {
    const err: HttpError = new Error("Vùng thi của Kỳ này không có Ngày/Ca nào hợp lệ theo đúng hệ đào tạo của Lớp");
    err.status = 400;
    throw err;
  }

  const minProctors = await getPolicyValue("MinProctorsPerExam");

  // Bước 1: dùng NGUYÊN VẸN logic /eligible (LTHI-02) — lọc riêng đúng Lớp đang xét, ĐỦ điều kiện thi
  // và CHƯA có lịch thi.
  const eligibleAll = await getEligibleExamSubjects(semesterId);
  const pendingSubjects = eligibleAll.filter((r) => r.ClassId === classId && r.DuDieuKienThi && !r.DaXepLichThi);

  // Việc CC: rải đều — mỗi ngày tối đa 1 ca thi/Lớp, trừ khi số môn cần thi nhiều hơn số NGÀY KHẢ DỤNG
  // (đã lọc đúng hệ đào tạo — vd Liên thông chỉ có T7/CN/T6) thì mới cho phép nhiều hơn 1 ca/ngày.
  const maxExamsPerDay = pendingSubjects.length > availableDateCount
    ? Math.ceil(pendingSubjects.length / availableDateCount)
    : 1;

  // Đếm số ca thi ĐÃ có sẵn (kể cả xếp tay trước đó) của Lớp này theo từng ngày trong vùng thi, để tôn
  // trọng đúng giới hạn "tối đa N ca/ngày" kể cả khi vùng thi đã có lịch thi từ trước.
  const existingCountResult = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("semesterId", sql.Int, semesterId)
    .input("rangeStart", sql.Date, examRangeStart)
    .input("rangeEnd", sql.Date, examRangeEnd)
    .query<{ ExamDate: string; Count: number }>(`
      SELECT CONVERT(VARCHAR(10), ExamDate, 23) AS ExamDate, COUNT(*) AS Count
      FROM Exams
      WHERE ClassId = @classId AND SemesterId = @semesterId AND Status <> N'Huy'
        AND ExamDate BETWEEN @rangeStart AND @rangeEnd
      GROUP BY ExamDate
    `);
  const dayCountTally = new Map<string, number>();
  for (const row of existingCountResult.recordset) dayCountTally.set(row.ExamDate, row.Count);

  const autoScheduleRunId = randomUUID();
  const subjectResults: AutoExamScheduleSubjectResult[] = [];
  const notifiedProctorIds = new Set<number>();
  const proctorLoadTally = new Map<number, number>();

  for (const subject of pendingSubjects) {
    const { examHours, practiceMode } = await getExamHoursAndMode(cls.MajorId, subject.SubjectId, cls.CohortId, semester.TermNumber);
    if (examHours <= 0) {
      subjectResults.push({
        subjectId: subject.SubjectId, subjectName: subject.SubjectName, isComplete: false,
        failureReason: "Môn này chưa cấu hình số tiết thi (ExamHours = 0)",
      });
      continue;
    }
    const durationMinutes = examHours * 60;

    const roomTypeNeeded = practiceMode === "LamSang" ? "LamSang" : "LyThuyet";
    let eligibleRoomIds = rooms.filter((r) => r.RoomType === roomTypeNeeded).map((r) => r.RoomId);
    // Chỉ áp dụng ưu tiên SubjectRooms (Việc BR/BU) cho nhánh Lâm sàng — SubjectRooms của môn thường
    // là phòng Thực hành thông thường, giao (intersect) với nhánh Lý thuyết sẽ luôn ra tập rỗng.
    if (roomTypeNeeded === "LamSang") {
      const subjectRoomIds = await getSubjectRoomIds(subject.SubjectId);
      if (subjectRoomIds.length > 0) {
        eligibleRoomIds = eligibleRoomIds.filter((id) => subjectRoomIds.includes(id));
      }
    }
    if (eligibleRoomIds.length === 0) {
      const label = roomTypeNeeded === "LamSang" ? "Lâm sàng" : "Lý thuyết";
      subjectResults.push({
        subjectId: subject.SubjectId, subjectName: subject.SubjectName, isComplete: false,
        failureReason: `Không có phòng ${label} nào khả dụng`,
      });
      continue;
    }

    let placed: AutoExamScheduleSubjectResult | null = null;
    for (const { date, session } of dateSessionSlots) {
      if ((dayCountTally.get(date) || 0) >= maxExamsPerDay) continue;

      const holiday = await findHoliday(date, majorClassInfo?.trainingMode);
      if (holiday) continue;

      const endTime = addMinutesToTime(session.StartTime, durationMinutes);
      if (endTime > session.EndTime) continue;

      if (await isClassSlotOccupied(classId, date, session.StartTime, endTime)) continue;

      const freeProctorIds = await findFreeProctorIds(date, session.StartTime, endTime);
      if (freeProctorIds.length < minProctors) continue;
      freeProctorIds.sort((a, b) => (proctorLoadTally.get(a) || 0) - (proctorLoadTally.get(b) || 0));

      let placedThisSlot = false;
      for (const roomId of eligibleRoomIds) {
        const proctorIds = freeProctorIds.slice(0, minProctors);
        const conflict = await checkExamConflict({ roomId, proctorIds, date, startTime: session.StartTime, endTime });
        if (conflict.hasConflict) continue;

        const insertResult = await pool
          .request()
          .input("semesterId", sql.Int, semesterId)
          .input("classId", sql.Int, classId)
          .input("subjectId", sql.Int, subject.SubjectId)
          .input("roomId", sql.Int, roomId)
          .input("examDate", sql.Date, date)
          .input("startTime", sql.VarChar, session.StartTime)
          .input("endTime", sql.VarChar, endTime)
          .input("autoScheduleRunId", sql.UniqueIdentifier, autoScheduleRunId)
          .input("createdBy", sql.Int, userId)
          .query<{ ExamId: number }>(`
            INSERT INTO Exams (SemesterId, ClassId, SubjectId, RoomId, ExamDate, StartTime, EndTime, AutoScheduleRunId, CreatedBy)
            OUTPUT INSERTED.ExamId
            VALUES (@semesterId, @classId, @subjectId, @roomId, @examDate, @startTime, @endTime, @autoScheduleRunId, @createdBy)
          `);
        const examId = insertResult.recordset[0].ExamId;
        for (const teacherId of proctorIds) {
          await pool
            .request()
            .input("examId", sql.Int, examId)
            .input("teacherId", sql.Int, teacherId)
            .query(`INSERT INTO ExamProctors (ExamId, TeacherId) VALUES (@examId, @teacherId)`);
          proctorLoadTally.set(teacherId, (proctorLoadTally.get(teacherId) || 0) + 1);
          notifiedProctorIds.add(teacherId);
        }

        dayCountTally.set(date, (dayCountTally.get(date) || 0) + 1);
        placed = {
          subjectId: subject.SubjectId, subjectName: subject.SubjectName, isComplete: true,
          examId, examDate: date, startTime: session.StartTime, endTime, roomId, proctorIds,
        };
        placedThisSlot = true;
        break;
      }
      if (placedThisSlot) break;
    }

    subjectResults.push(
      placed ?? {
        subjectId: subject.SubjectId, subjectName: subject.SubjectName, isComplete: false,
        failureReason: "Hết ngày trong vùng thi hoặc không đủ phòng/giám thị trống — không tìm được ca thi hợp lệ",
      }
    );
  }

  await writeAuditLog({
    userId, action: "Insert", tableName: "Exams", recordId: null,
    detail: { classId, semesterId, autoScheduleRunId, subjectResults },
  });

  if (notifiedProctorIds.size > 0) {
    await notifyTeachers(
      [...notifiedProctorIds],
      `Bạn được phân công coi thi trong đợt tự động xếp lịch thi vừa chạy — vào lịch để xem chi tiết.`,
      "Exam",
      null
    );
  }

  return { autoScheduleRunId, subjectResults };
}

export async function cancelAutoExamScheduleRun(runId: string, userId: number): Promise<number> {
  const pool = await getPool();
  const idsResult = await pool
    .request()
    .input("runId", sql.UniqueIdentifier, runId)
    .query<{ ExamId: number }>(`SELECT ExamId FROM Exams WHERE AutoScheduleRunId = @runId`);
  const examIds = idsResult.recordset.map((r) => r.ExamId);
  if (examIds.length === 0) return 0;

  await pool.request().input("runId", sql.UniqueIdentifier, runId).query(`DELETE FROM Exams WHERE AutoScheduleRunId = @runId`);
  await writeAuditLog({
    userId, action: "Delete", tableName: "Exams",
    recordId: null, detail: { autoScheduleRunId: runId, deletedCount: examIds.length, examIds },
  });
  return examIds.length;
}
