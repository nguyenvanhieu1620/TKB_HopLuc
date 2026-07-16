import { randomUUID } from "crypto";
import { sql, getPool } from "../config/db";
import { HttpError } from "../types";
import { getPolicyValue } from "./policyConfig";
import {
  getPeriodMinutes, getTotalPeriodsForSubject, getPeriodTimelineForSubject, getWeeksInSemester,
  checkRoomCapacity, checkSessionLength, checkDailyHoursLimit, checkTeacherWeeklyHours, checkTeacherYearlyHours,
  CAPACITY_POLICY_BY_ROOM_TYPE, ROOM_TYPES_BY_CATEGORY, roomCategoryFor,
} from "./policyRules";
import { checkScheduleConflict, findHoliday } from "./conflictCheck";
import { checkTrainingModeRule, getClassTrainingMode } from "./trainingModeCheck";
import { writeAuditLog } from "./auditLog";
import { notifyTeachers } from "./notify";

export interface AutoScheduleSubjectResult {
  subjectId: number;
  subjectName: string;
  periodsNeeded: number;
  periodsScheduled: number;
  isComplete: boolean;
  failureReason?: string;
}
export interface AutoScheduleReport {
  autoScheduleRunId: string;
  totalPeriodsNeeded: number;
  totalPeriodsScheduled: number;
  subjectResults: AutoScheduleSubjectResult[];
}

// Cùng cách tính dịch ngày (YYYY-MM-DD) đã dùng ở scheduleController.ts/classController.ts (tính
// bằng UTC để tránh lệch múi giờ server) — duy trì đúng quy ước hiện có, không đổi cách khác.
function shiftDateStr(dateStr: string, offsetDays: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + Math.round(minutes);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

interface RoomRow { RoomId: number; RoomType: string; }
interface SessionRow { SessionId: number; StartTime: string; EndTime: string; SortOrder: number; }

interface SubjectTask {
  subjectId: number;
  subjectName: string;
  practiceMode: string;
  theoryRemaining: number;
  practiceRemaining: number;
  teacherIds: number[];
}

interface RunContext {
  classId: number;
  semesterId: number;
  trainingMode: "CQ" | "LT" | null;
  rangeStart: string;
  rangeEnd: string;
  sessions: SessionRow[];
  teacherLoadTally: Map<number, number>;
  autoScheduleRunId: string;
  userId: number;
  notifiedTeacherIds: Set<number>;
}

async function deleteScheduleRow(scheduleId: number): Promise<void> {
  const pool = await getPool();
  await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
}

interface InsertSessionParams {
  subjectId: number;
  roomId: number;
  teacherId: number;
  date: string;
  startTime: string;
  endTime: string;
  sessionType: "Theory" | "Practice";
  groupLabel?: string | null;
}

async function insertSession(ctx: RunContext, params: InsertSessionParams): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("semesterId", sql.Int, ctx.semesterId)
    .input("classId", sql.Int, ctx.classId)
    .input("subjectId", sql.Int, params.subjectId)
    .input("roomId", sql.Int, params.roomId)
    .input("scheduleDate", sql.Date, params.date)
    .input("startTime", sql.VarChar, params.startTime)
    .input("endTime", sql.VarChar, params.endTime)
    .input("sessionType", sql.NVarChar, params.sessionType)
    .input("groupLabel", sql.NVarChar, params.groupLabel || null)
    .input("autoScheduleRunId", sql.UniqueIdentifier, ctx.autoScheduleRunId)
    .input("createdBy", sql.Int, ctx.userId)
    .query<{ ScheduleId: number }>(`
      INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, SessionType, GroupLabel, AutoScheduleRunId, CreatedBy)
      OUTPUT INSERTED.ScheduleId
      VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @sessionType, @groupLabel, @autoScheduleRunId, @createdBy)
    `);
  const scheduleId = result.recordset[0].ScheduleId;
  await pool
    .request()
    .input("scheduleId", sql.Int, scheduleId)
    .input("teacherId", sql.Int, params.teacherId)
    .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
  return scheduleId;
}

interface PlaceBlockParams {
  subjectId: number;
  sessionType: "Theory" | "Practice";
  periods: number;
  periodMinutes: number;
  eligibleRoomIds: number[];
  teacherIds: number[];
  totalStudents: number;
  groupLabel?: string | null;
}

// 1 buổi (1 Ngày + 1 Ca cụ thể) của 1 Lớp chỉ dành cho ĐÚNG 1 MÔN — không chia nhỏ nhét nhiều môn
// khác nhau vào cùng buổi (kể cả khi chưa dùng hết giới hạn tiết tối đa/buổi). Kiểm tra CẢ Ca (không
// chỉ đúng khoảng phút của block đang thử) đã có Schedule của Lớp này thuộc MÔN KHÁC hay chưa — có
// thì bỏ qua slot này. Không áp dụng cho các dòng CÙNG môn (vd Tách nhóm/Ghép lớp tự tạo nhiều dòng
// cho cùng 1 môn ở cùng slot — đó là cơ chế khác, không phải "môn khác chen vào").
async function isSlotTakenByOtherSubject(classId: number, date: string, session: SessionRow, subjectId: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("date", sql.Date, date)
    .input("sessionStart", sql.VarChar, session.StartTime)
    .input("sessionEnd", sql.VarChar, session.EndTime)
    .input("subjectId", sql.Int, subjectId)
    .query<{ ScheduleId: number }>(`
      SELECT TOP 1 ScheduleId FROM Schedule
      WHERE ClassId = @classId AND ScheduleDate = @date
        AND StartTime < @sessionEnd AND EndTime > @sessionStart
        AND SubjectId <> @subjectId
    `);
  return result.recordset.length > 0;
}

// Dò (Ngày, Ca) tăng dần trong khung [rangeStart, rangeEnd] — với mỗi (Ngày, Ca) hợp lệ theo Hệ đào
// tạo (checkTrainingModeRule dùng như BỘ LỌC CỨNG ở đây, khác với xếp tay chỉ cảnh báo) và CHƯA bị
// môn khác chiếm buổi (isSlotTakenByOtherSubject), thử từng GV (ưu tiên GV đang có ít giờ nhất trong
// lần chạy này) × từng Phòng phù hợp — gọi ĐỦ các hàm kiểm tra đã có, pass hết thì tạo thật ngay (lưu
// ngay theo đúng chỉ đạo, không bọc transaction lớn).
async function tryPlaceSingleBlock(ctx: RunContext, params: PlaceBlockParams): Promise<{ success: boolean; scheduleId?: number }> {
  let cursor = ctx.rangeStart;
  while (cursor <= ctx.rangeEnd) {
    const date = cursor;
    cursor = shiftDateStr(cursor, 1);

    const holiday = await findHoliday(date, ctx.trainingMode);
    if (holiday) continue;

    for (const session of ctx.sessions) {
      const endTime = addMinutesToTime(session.StartTime, params.periods * params.periodMinutes);
      if (endTime > session.EndTime) continue;

      const trainingCheck = await checkTrainingModeRule({ classId: ctx.classId, scheduleDate: date, startTime: session.StartTime });
      if (trainingCheck.violated) continue;

      const takenByOther = await isSlotTakenByOtherSubject(ctx.classId, date, session, params.subjectId);
      if (takenByOther) continue;

      // Tối ưu hiệu năng QUAN TRỌNG: mọi phòng trong `eligibleRoomIds` CÙNG 1 nhóm loại phòng nên
      // checkSessionLength/checkDailyHoursLimit (chỉ phụ thuộc NHÓM loại phòng qua periodMinutes,
      // không phụ thuộc phòng cụ thể nào) cho ra CÙNG kết quả với BẤT KỲ phòng nào trong danh sách —
      // gọi 1 LẦN bằng phòng đại diện thay vì lặp lại cho từng phòng × từng GV, tránh hàng chục
      // nghìn lệnh gọi DB thừa khi khung Kỳ dài và có nhiều Phòng/GV khả dĩ.
      const representativeRoomId = params.eligibleRoomIds[0];
      const sessionLengthCheck = await checkSessionLength({ roomId: representativeRoomId, startTime: session.StartTime, endTime });
      if (sessionLengthCheck.violated) continue;

      const dailyHoursCheck = await checkDailyHoursLimit({
        classId: ctx.classId, scheduleDate: date, roomId: representativeRoomId, startTime: session.StartTime, endTime,
      });
      if (dailyHoursCheck.violated) continue;

      const sortedTeachers = [...params.teacherIds].sort(
        (a, b) => (ctx.teacherLoadTally.get(a) || 0) - (ctx.teacherLoadTally.get(b) || 0)
      );
      for (const teacherId of sortedTeachers) {
        // Cùng lý do — giờ dạy chuẩn (weekly/yearly) chỉ phụ thuộc GV + độ dài quy đổi theo NHÓM
        // loại phòng, không phụ thuộc phòng cụ thể nào trong cùng nhóm — gọi 1 lần/GV thay vì
        // lặp lại cho từng phòng.
        const weeklyCheck = await checkTeacherWeeklyHours({ teacherId, scheduleDate: date, roomId: representativeRoomId, startTime: session.StartTime, endTime });
        if (weeklyCheck.violated) continue;

        const yearlyCheck = await checkTeacherYearlyHours({ teacherId, scheduleDate: date, roomId: representativeRoomId, startTime: session.StartTime, endTime });
        if (yearlyCheck.violated) continue;

        for (const roomId of params.eligibleRoomIds) {
          // Chỉ còn 2 kiểm tra THẬT SỰ phụ thuộc phòng cụ thể: phòng có đang bận (conflict/GV
          // trùng giờ) và sĩ số có vừa phòng đó không.
          const conflict = await checkScheduleConflict({
            roomId, teacherIds: [teacherId], date, startTime: session.StartTime, endTime,
          });
          if (conflict.hasConflict) continue;

          const capacityCheck = await checkRoomCapacity({ roomId, totalStudents: params.totalStudents });
          if (capacityCheck.violated) continue;

          const scheduleId = await insertSession(ctx, {
            subjectId: params.subjectId, roomId, teacherId, date,
            startTime: session.StartTime, endTime, sessionType: params.sessionType, groupLabel: params.groupLabel,
          });
          ctx.teacherLoadTally.set(teacherId, (ctx.teacherLoadTally.get(teacherId) || 0) + params.periods);
          ctx.notifiedTeacherIds.add(teacherId);
          return { success: true, scheduleId };
        }
      }
    }
  }
  return { success: false };
}

interface PlaceGroupSplitParams extends PlaceBlockParams {
  groupCount: number;
}

// Tách nhóm: dò slot ĐỘC LẬP cho từng nhóm (đơn giản hóa so với "ưu tiên cùng slot, else xoay vòng"
// — xem ghi chú trong kế hoạch triển khai). ALL-OR-NOTHING: 1 nhóm không đặt được thì hủy các nhóm
// đã lỡ đặt trong lần thử block này. Đặt được đủ N nhóm thì đánh dấu chung GroupBatchId = ScheduleId
// của nhóm đầu tiên — CÙNG quy ước với groupedCreate() hiện có (Việc BB), để tiến độ (
// getPeriodTimelineForSubject) không đếm trùng N nhóm thành N buổi.
async function tryPlaceGroupSplitBlock(ctx: RunContext, params: PlaceGroupSplitParams): Promise<{ success: boolean }> {
  const perGroupSize = Math.ceil(params.totalStudents / params.groupCount);
  const scheduleIds: number[] = [];

  for (let g = 0; g < params.groupCount; g++) {
    const result = await tryPlaceSingleBlock(ctx, {
      ...params, totalStudents: perGroupSize, groupLabel: `Nhóm ${g + 1}`,
    });
    if (!result.success) {
      for (const id of scheduleIds) await deleteScheduleRow(id);
      return { success: false };
    }
    scheduleIds.push(result.scheduleId!);
  }

  const groupBatchId = scheduleIds[0];
  const pool = await getPool();
  const batchRequest = pool.request().input("batchId", sql.Int, groupBatchId);
  const idPlaceholders = scheduleIds
    .map((id, i) => {
      batchRequest.input(`sid${i}`, sql.Int, id);
      return `@sid${i}`;
    })
    .join(", ");
  await batchRequest.query(`UPDATE Schedule SET GroupBatchId = @batchId WHERE ScheduleId IN (${idPlaceholders})`);
  return { success: true };
}

// Xử lý 1 phần (Lý thuyết hoặc Thực hành) của 1 môn TRONG TUẦN đang xét: tính nhóm phòng, sĩ số/
// nhóm, rồi lặp xếp từng block trong khung tuần (ctx.rangeStart..ctx.rangeEnd).
//
// - KÍCH THƯỚC 1 block luôn tính từ `wholeRemaining` (phần còn thiếu CẢ MÔN, không phải chỉ tiêu
//   tuần) — blockSize = MIN(phần còn lại CẢ MÔN tại thời điểm đó, giới hạn tối đa/buổi) — để luôn cố
//   xếp TRỌN VẸN tối đa cho phép/buổi, không chia nhỏ theo chỉ tiêu tuần (Lỗi 2). Nếu kích thước đó
//   không đặt được ở đâu trong tuần, giảm dần để thử, nhưng KHÔNG giảm xuống dưới 2 tiết trừ khi phần
//   còn lại CẢ MÔN tại lượt lặp đó đúng bằng 1 — tránh tạo buổi lẻ tẻ 1 tiết không cần thiết.
// - VÒNG LẶP (bao nhiêu block/buổi xếp trong 1 lần chạy tuần này) dừng khi đạt `quotaThisWeek` (chỉ
//   tiêu tuần, có thể xếp NHỈNH hơn 1 chút vì block cuối luôn xếp trọn vẹn, không cắt giữa chừng) HOẶC
//   khi môn đã xếp xong hoàn toàn — để các môn khác trong cùng tuần vẫn còn slot mà xếp, không bị 1
//   môn chiếm hết cả tuần (đã xác nhận qua test thực tế: bỏ hẳn giới hạn này khiến môn xử lý trước
//   chiếm hết slot của cả tuần, các môn xử lý sau nhận 0 tiết).
async function processSubjectPart(
  ctx: RunContext,
  task: SubjectTask,
  sessionType: "Theory" | "Practice",
  wholeRemaining: number,
  quotaThisWeek: number,
  rooms: RoomRow[],
  classSize: number
): Promise<{ scheduled: number; failureReason?: string }> {
  const roomCategory = sessionType === "Theory" ? "LyThuyet" : roomCategoryFor(task.practiceMode, "Practice");
  const eligibleRoomIds = rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[roomCategory]?.includes(r.RoomType)).map((r) => r.RoomId);
  if (eligibleRoomIds.length === 0) {
    const label = roomCategory === "LyThuyet" ? "Lý thuyết" : roomCategory === "LamSang" ? "Lâm sàng" : "Thực hành";
    return { scheduled: 0, failureReason: `Không có phòng ${label} nào khả dụng` };
  }

  const periodMinutes = await getPeriodMinutes(roomCategory);
  const maxPerSessionKey = sessionType === "Theory" ? "MaxTheoryHoursPerSession" : "MaxPracticeHoursPerSession";
  const maxPerSession = await getPolicyValue(maxPerSessionKey);
  const capacityPolicyKey = CAPACITY_POLICY_BY_ROOM_TYPE[roomCategory];
  const capacityLimit = await getPolicyValue(capacityPolicyKey);
  const groupCount = classSize > capacityLimit ? Math.ceil(classSize / capacityLimit) : 1;

  let scheduled = 0;
  let left = wholeRemaining;
  while (scheduled < quotaThisWeek && left > 0) {
    let blockSize = Math.min(left, maxPerSession);
    const minBlockSize = left === 1 ? 1 : 2;
    let placed = false;
    while (blockSize >= minBlockSize) {
      const params: PlaceBlockParams = {
        subjectId: task.subjectId, sessionType, periods: blockSize, periodMinutes,
        eligibleRoomIds, teacherIds: task.teacherIds, totalStudents: classSize,
      };
      const result = groupCount > 1
        ? await tryPlaceGroupSplitBlock(ctx, { ...params, groupCount })
        : await tryPlaceSingleBlock(ctx, params);
      if (result.success) {
        left -= blockSize;
        scheduled += blockSize;
        placed = true;
        break;
      }
      blockSize -= 1;
    }
    if (!placed) {
      const label = sessionType === "Theory" ? "Lý thuyết" : "Thực hành";
      return { scheduled, failureReason: `Hết slot hợp lệ trong Tuần này cho phần ${label} — còn thiếu ${left} tiết` };
    }
  }
  return { scheduled };
}

export async function runAutoSchedule(classId: number, semesterId: number, weekNumber: number, userId: number): Promise<AutoScheduleReport> {
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
    .query<{ StartDate: string; EndDate: string; TeachingEndDate: string | null; TermNumber: number | null }>(`
      SELECT CONVERT(VARCHAR(10), StartDate, 23) AS StartDate, CONVERT(VARCHAR(10), EndDate, 23) AS EndDate,
             CONVERT(VARCHAR(10), TeachingEndDate, 23) AS TeachingEndDate, TermNumber
      FROM Semesters WHERE SemesterId = @semesterId AND ClassId = @classId
    `);
  const semester = semesterResult.recordset[0];
  if (!semester) {
    const err: HttpError = new Error("Không tìm thấy Kỳ học thuộc đúng Lớp này");
    err.status = 400;
    throw err;
  }

  // Xếp CHỈ trong đúng 1 Tuần của Kỳ (Tuần 1..N tính từ StartDate, cùng cách đánh số đã dùng ở
  // frontend/utils/calendar.ts's getWeeksInSemester — bản backend là getWeeksInSemester trong
  // policyRules.ts) — KHÔNG động tới các tuần khác. Chỉ tính trong phạm vi TeachingEndDate (chừa
  // vùng thi cuối kỳ), không tính các tuần đã qua vùng thi.
  const teachingEnd = semester.TeachingEndDate || semester.EndDate;
  const weeks = getWeeksInSemester(semester.StartDate, teachingEnd);
  if (weekNumber < 1 || weekNumber > weeks.length) {
    const err: HttpError = new Error(`Tuần không hợp lệ — Kỳ này có ${weeks.length} tuần trong phạm vi dạy học`);
    err.status = 400;
    throw err;
  }
  const targetWeek = weeks[weekNumber - 1];
  const weeksRemaining = weeks.length - weekNumber + 1;

  const classInfo = await getClassTrainingMode(classId);

  const sessionsResult = await pool.request().query<SessionRow>(`
    SELECT SessionId, CONVERT(VARCHAR(5), StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), EndTime, 108) AS EndTime, SortOrder
    FROM Sessions WHERE IsActive = 1 ORDER BY SortOrder
  `);
  const roomsResult = await pool.request().query<RoomRow>(`SELECT RoomId, RoomType FROM Rooms WHERE IsActive = 1`);

  // Môn cần học: CurriculumItems theo (MajorId, TermNumber), ưu tiên dòng khớp CohortId — cùng
  // pattern ROW_NUMBER đã dùng ở curriculumItemController.list().
  const curriculumResult = await pool
    .request()
    .input("majorId", sql.Int, cls.MajorId)
    .input("termNumber", sql.Int, semester.TermNumber)
    .input("cohortId", sql.Int, cls.CohortId)
    .query<{ SubjectId: number; SubjectName: string; PracticeMode: string }>(`
      WITH ranked AS (
        SELECT ci.SubjectId, ci.PracticeMode,
               ROW_NUMBER() OVER (PARTITION BY ci.SubjectId ORDER BY CASE WHEN ci.CohortId = @cohortId THEN 0 ELSE 1 END) AS rn
        FROM CurriculumItems ci
        WHERE ci.MajorId = @majorId AND ci.TermNumber = @termNumber AND ci.IsActive = 1
          AND (ci.CohortId = @cohortId OR ci.CohortId IS NULL)
      )
      SELECT r.SubjectId, sub.SubjectName, r.PracticeMode
      FROM ranked r
      INNER JOIN Subjects sub ON sub.SubjectId = r.SubjectId
      WHERE r.rn = 1 AND sub.IsActive = 1
      ORDER BY sub.SubjectName
    `);

  const subjectTasks: SubjectTask[] = await Promise.all(
    curriculumResult.recordset.map(async (row) => {
      const [targets, timeline, teacherResult] = await Promise.all([
        getTotalPeriodsForSubject(cls.MajorId, row.SubjectId, cls.CohortId, semester.TermNumber),
        getPeriodTimelineForSubject(classId, row.SubjectId),
        pool.request().input("subjectId", sql.Int, row.SubjectId).query<{ TeacherId: number }>(`
          SELECT ts.TeacherId FROM TeacherSubjects ts
          INNER JOIN Teachers t ON t.TeacherId = ts.TeacherId
          WHERE ts.SubjectId = @subjectId AND t.IsActive = 1
        `),
      ]);
      const lastEntry = timeline[timeline.length - 1];
      const theoryDone = lastEntry?.cumulativeTheoryPeriods ?? 0;
      const practiceDone = lastEntry?.cumulativePracticePeriods ?? 0;
      return {
        subjectId: row.SubjectId,
        subjectName: row.SubjectName,
        practiceMode: row.PracticeMode,
        theoryRemaining: Math.max(0, targets.theoryTarget - theoryDone),
        practiceRemaining: Math.max(0, targets.practiceTarget - practiceDone),
        teacherIds: teacherResult.recordset.map((t) => t.TeacherId),
      };
    })
  );

  // Sắp xếp môn ÍT lựa chọn nhất (GV/phòng) xử lý trước — không dùng Category (chưa được rà soát
  // đầy đủ trong dữ liệu thật, xem ghi chú trong kế hoạch triển khai).
  const rooms = roomsResult.recordset;
  const theoryRoomCount = rooms.filter((r) => ROOM_TYPES_BY_CATEGORY.LyThuyet.includes(r.RoomType)).length;
  function difficultyScore(task: SubjectTask): number {
    const practiceCategory = roomCategoryFor(task.practiceMode, "Practice");
    const practiceRoomCount = rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[practiceCategory]?.includes(r.RoomType)).length;
    return task.teacherIds.length * (theoryRoomCount + practiceRoomCount);
  }
  subjectTasks.sort((a, b) => difficultyScore(a) - difficultyScore(b) || a.subjectId - b.subjectId);

  const autoScheduleRunId = randomUUID();
  const ctx: RunContext = {
    classId, semesterId,
    trainingMode: classInfo?.trainingMode ?? null,
    rangeStart: targetWeek.start,
    rangeEnd: targetWeek.end > teachingEnd ? teachingEnd : targetWeek.end,
    sessions: sessionsResult.recordset,
    teacherLoadTally: new Map(),
    autoScheduleRunId,
    userId,
    notifiedTeacherIds: new Set(),
  };

  const subjectResults: AutoScheduleSubjectResult[] = [];
  for (const task of subjectTasks) {
    const totalRemaining = task.theoryRemaining + task.practiceRemaining;
    if (totalRemaining === 0) {
      subjectResults.push({
        subjectId: task.subjectId, subjectName: task.subjectName,
        periodsNeeded: 0, periodsScheduled: 0, isComplete: true,
      });
      continue;
    }

    // Chỉ tiêu TUẦN NÀY (chia đều số tiết còn thiếu cả Kỳ cho số tuần còn lại, làm tròn lên) dùng
    // CHO 2 việc: (1) quyết định phần nào (Lý thuyết/Thực hành) của môn này được XÉT xử lý trong
    // tuần đang chạy — quota luôn > 0 khi phần đó còn thiếu; (2) làm giới hạn TỔNG SỐ TIẾT xếp được
    // của phần đó TRONG TUẦN NÀY (vòng lặp ngoài của processSubjectPart dừng khi đạt quota) — đây là
    // phần tự sửa lại so với bản đầu: thử bỏ hẳn giới hạn này (chỉ dùng quota để bật/tắt xét môn,
    // không chặn số tiết) và test thật cho thấy 1-2 môn xử lý trước (theo thứ tự độ khó) chiếm hết
    // slot cả tuần, các môn còn lại nhận 0 tiết — sai với tinh thần "xếp dần đều qua các tuần". Nên
    // quota vẫn cần chặn TỔNG số tiết/tuần để công bằng giữa các môn.
    // Cái ĐÚNG THEO YÊU CẦU đã sửa là KÍCH THƯỚC 1 BLOCK: processSubjectPart không còn tính blockSize
    // từ quota nữa mà tính từ phần còn thiếu CẢ MÔN (task.theoryRemaining/practiceRemaining) — luôn
    // cố xếp TRỌN VẸN tối đa/buổi thay vì cắt nhỏ theo chỉ tiêu tuần — nên block cuối cùng của 1 môn
    // trong tuần vẫn có thể NHỈNH hơn quota một chút (quota không cắt giữa block), chỉ không được nhỏ
    // hơn giới hạn tối thiểu 2 tiết (trừ khi còn đúng 1 tiết cuối cùng của cả môn).
    // periodsNeeded/periodsScheduled báo cáo theo phần còn thiếu THẬT của cả môn (không phải theo
    // chỉ tiêu tuần).
    const theoryQuota = task.theoryRemaining > 0 ? Math.ceil(task.theoryRemaining / weeksRemaining) : 0;
    const practiceQuota = task.practiceRemaining > 0 ? Math.ceil(task.practiceRemaining / weeksRemaining) : 0;
    const periodsNeeded = totalRemaining;

    if (task.teacherIds.length === 0) {
      subjectResults.push({
        subjectId: task.subjectId, subjectName: task.subjectName,
        periodsNeeded, periodsScheduled: 0, isComplete: false,
        failureReason: "Không có giảng viên nào dạy được môn này",
      });
      continue;
    }

    let scheduled = 0;
    const reasons: string[] = [];

    if (theoryQuota > 0) {
      const result = await processSubjectPart(ctx, task, "Theory", task.theoryRemaining, theoryQuota, rooms, cls.ClassSize);
      scheduled += result.scheduled;
      if (result.failureReason) reasons.push(result.failureReason);
    }
    if (practiceQuota > 0) {
      const result = await processSubjectPart(ctx, task, "Practice", task.practiceRemaining, practiceQuota, rooms, cls.ClassSize);
      scheduled += result.scheduled;
      if (result.failureReason) reasons.push(result.failureReason);
    }

    const isComplete = scheduled >= periodsNeeded;
    subjectResults.push({
      subjectId: task.subjectId, subjectName: task.subjectName,
      periodsNeeded, periodsScheduled: scheduled, isComplete,
      failureReason: isComplete ? undefined : reasons.join(" | "),
    });
  }

  const totalPeriodsNeeded = subjectResults.reduce((sum, r) => sum + r.periodsNeeded, 0);
  const totalPeriodsScheduled = subjectResults.reduce((sum, r) => sum + r.periodsScheduled, 0);

  await writeAuditLog({
    userId, action: "Insert", tableName: "Schedule",
    recordId: null, detail: { classId, semesterId, autoScheduleRunId, totalPeriodsNeeded, totalPeriodsScheduled, subjectResults },
  });

  // Gửi 1 thông báo tổng hợp/GV thay vì gửi riêng từng buổi (cùng cách copyWeek đã làm) — tránh
  // spam khi 1 lần chạy có thể tạo ra hàng chục tiết.
  if (totalPeriodsScheduled > 0 && ctx.notifiedTeacherIds.size > 0) {
    const classNameResult = await pool.request().input("classId", sql.Int, classId).query<{ ClassName: string }>(
      `SELECT ClassName FROM Classes WHERE ClassId = @classId`
    );
    const className = classNameResult.recordset[0]?.ClassName ?? `Lớp #${classId}`;
    await notifyTeachers(
      Array.from(ctx.notifiedTeacherIds),
      `TKB lớp ${className} vừa được tự động xếp thêm ${totalPeriodsScheduled} tiết`,
      "Schedule",
      null
    );
  }

  return { autoScheduleRunId, totalPeriodsNeeded, totalPeriodsScheduled, subjectResults };
}

export async function cancelAutoScheduleRun(runId: string, userId: number): Promise<number> {
  const pool = await getPool();
  const idsResult = await pool
    .request()
    .input("runId", sql.UniqueIdentifier, runId)
    .query<{ ScheduleId: number }>(`SELECT ScheduleId FROM Schedule WHERE AutoScheduleRunId = @runId`);
  const scheduleIds = idsResult.recordset.map((r) => r.ScheduleId);
  if (scheduleIds.length === 0) return 0;

  await pool.request().input("runId", sql.UniqueIdentifier, runId).query(`DELETE FROM Schedule WHERE AutoScheduleRunId = @runId`);
  await writeAuditLog({
    userId, action: "Delete", tableName: "Schedule",
    recordId: null, detail: { autoScheduleRunId: runId, deletedCount: scheduleIds.length, scheduleIds },
  });
  return scheduleIds.length;
}
