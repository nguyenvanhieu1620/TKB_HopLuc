import { randomUUID } from "crypto";
import { sql, getPool } from "../config/db";
import { HttpError } from "../types";
import { getPolicyValue } from "./policyConfig";
import {
  getPeriodMinutes, getTotalPeriodsForSubject, getPeriodTimelineForSubject, getWeeksInSemester,
  checkRoomCapacity, checkSessionLength, checkDailyHoursLimit, checkTeacherWeeklyHours, checkTeacherYearlyHours,
  CAPACITY_POLICY_BY_ROOM_TYPE, ROOM_TYPES_BY_CATEGORY, roomCategoryFor, getRequiredGroupCount, getSubjectRoomIds,
  getSubjectRequiresGrouping,
} from "./policyRules";
import { checkScheduleConflict, findHoliday } from "./conflictCheck";
import { checkTrainingModeRule, getClassTrainingMode, classifyPeriod, getWeekday } from "./trainingModeCheck";
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
  category: string | null;
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
  // Việc BN: true khi block này là Lâm sàng (roomCategory === "LamSang") — dùng để loại Ca Tối khỏi
  // danh sách Ca khả dụng (vấn đề 1), độc lập với checkTrainingModeRule.
  // Việc BV: mở rộng — CŨNG true khi toàn bộ eligibleRoomIds của block là phòng Sân bãi (RoomType =
  // SanBai, thường dùng cho Giáo dục thể chất) — không phù hợp học buổi tối, cùng nguyên tắc Lâm sàng.
  isClinical?: boolean;
  // Giới hạn tối đa/buổi bình thường (MaxTheoryHoursPerSession/MaxPracticeHoursPerSession) — dùng để
  // nhận diện block "ghép buổi cuối" của computeBlockPlan (Thực hành/Lâm sàng, dư 1 tiết): khi
  // periods === maxPerSession + 1 ĐÚNG BẰNG giá trị này, đây là ngoại lệ có chủ đích (không phải lỗi),
  // nên BỎ QUA checkSessionLength cho riêng trường hợp này thay vì bị chặn cứng như buổi thường.
  maxPerSession: number;
  // Việc BT: false khi môn KHÔNG cần chia nhóm (Subjects.RequiresGrouping = 0, vd Giáo dục thể chất
  // học ở sân bãi rộng) — dùng để checkRoomCapacity so với sức chứa THẬT của phòng (như buổi ĐÃ tách
  // nhóm) thay vì mốc chính sách MaxStudentsPerPracticeGroup/MaxStudentsPerClinicalGroup, vì thực chất
  // không có nhóm nào cả dù groupLabel vẫn NULL (cả lớp học chung). Theory luôn true (không áp dụng).
  requiresGrouping: boolean;
}

// Việc BM (vấn đề 2): 1 buổi (1 Ngày + 1 Ca cụ thể) của 1 Lớp — buổi KHÔNG tách nhóm (groupLabel
// NULL, học chung cả lớp, vd Lý thuyết) chỉ dành cho ĐÚNG 1 MÔN, giữ nguyên quy tắc cũ. Buổi CÓ tách
// nhóm (groupLabel khác NULL): đơn vị độc quyền là (Lớp, NHÓM, Ngày, Ca) — mỗi NHÓM chỉ học đúng 1
// môn, nhưng các NHÓM KHÁC NHAU của cùng buổi được phép học môn KHÁC NHAU (vd Nhóm 1+2 học Thực hành
// môn X ở 2 phòng khác nhau, Nhóm 3 học Thực hành môn Y ở phòng khác — học ở phòng riêng, không đụng
// nhau).
//
// Việc BP: ĐÃ BỎ điều kiện "SubjectId <> @subjectId" từng có ở đây — chẩn đoán qua log chi tiết
// (Tuần 12-13 của 1 Lớp Liên thông, xem lịch sử thay đổi) phát hiện đây là lỗi thật, không phải hết
// nhu cầu: điều kiện đó vốn định dùng để KHÔNG tự chặn các dòng Tách nhóm CỦA CHÍNH 1 lần gọi
// tryPlaceGroupSplitBlock (Nhóm 1, Nhóm 2... cùng môn, cùng slot) — nhưng processSubjectPart gọi LẠI
// tryPlaceSingleBlock/tryPlaceGroupSplitBlock nhiều lần (mỗi block 1 lần, cùng 1 môn, trong cùng 1
// tuần), và mỗi lần dò lại từ đầu danh sách slot — nên "luôn miễn trừ cùng môn" vô tình cho phép
// CHÍNH môn đó tự đặt NHIỀU block khác nhau (khác GV/Phòng, không phải Tách nhóm thật) vào ĐÚNG CÙNG
// 1 (Ngày, Ca), dồn quá nhiều tiết vào 1 buổi — khiến checkDailyHoursLimit của NGÀY đó bị tính vượt
// ngưỡng ngay từ sớm, chặn nhầm các slot xử lý SAU trong cùng ngày (vd Chiều Chủ nhật, xử lý sau
// Sáng Chủ nhật) dù bản thân slot đó thực ra còn trống. SỬA: bỏ hẳn miễn trừ theo SubjectId, chỉ còn
// dựa vào GroupLabel — an toàn cho Tách nhóm thật vì mỗi lần gọi tryPlaceGroupSplitBlock luôn sinh
// NHÃN MỚI "Nhóm 1".."Nhóm N" (không trùng nhãn giữa các nhóm trong CÙNG 1 lần gọi), nên các nhóm đó
// vốn dĩ không cần miễn trừ theo môn mới phân biệt được với nhau. Kết quả: (Ngày, Ca, Nhóm) giờ chỉ
// được CHIẾM DỤNG ĐÚNG 1 LẦN, không phân biệt môn nào đặt trước — kể cả cùng 1 môn.
async function isSlotOccupied(classId: number, date: string, session: SessionRow, groupLabel: string | null): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("date", sql.Date, date)
    .input("sessionStart", sql.VarChar, session.StartTime)
    .input("sessionEnd", sql.VarChar, session.EndTime)
    .input("groupLabel", sql.NVarChar, groupLabel)
    .query<{ ScheduleId: number }>(`
      SELECT TOP 1 ScheduleId FROM Schedule
      WHERE ClassId = @classId AND ScheduleDate = @date
        AND StartTime < @sessionEnd AND EndTime > @sessionStart
        AND (@groupLabel IS NULL OR GroupLabel IS NULL OR GroupLabel = @groupLabel)
    `);
  return result.recordset.length > 0;
}

interface DateSessionSlot { date: string; session: SessionRow; }

// Việc BQ: thứ tự ưu tiên ĐẦY ĐỦ khi sinh danh sách (Ngày, Ca) khả dụng trong tuần cho Lớp kiểu Liên
// thông — THAY THẾ HOÀN TOÀN mọi bản thứ tự ưu tiên đã gửi trước đây (Việc BN, Việc BO), dùng bản này
// làm chuẩn CUỐI CÙNG. Từ ưu tiên cao xuống thấp:
//   1. Thứ 7 Sáng, Thứ 7 Chiều, Chủ nhật Sáng, Chủ nhật Chiều
//   2. Tối Thứ 5, Tối Thứ 6 (chỉ dùng khi nhóm 1 đã hết chỗ)
//   3. Tối Thứ 7 (chỉ dùng khi nhóm 1+2 đã hết chỗ)
//   4. Tối Thứ 2, Tối Thứ 3, Tối Thứ 4 (phương án CUỐI CÙNG, chỉ dùng khi nhóm 1+2+3 đều đã hết chỗ)
// Tối Chủ nhật KHÔNG BAO GIỜ đưa vào danh sách. Thứ 2-6 Sáng/Chiều cũng không đưa vào — chưa từng hợp
// lệ với hệ Liên thông theo checkTrainingModeRule, đưa vào chỉ tốn vòng lặp thử vô ích.
// weekday: 0=CN,1=T2,2=T3,3=T4,4=T5,5=T6,6=T7 (cùng quy ước getWeekday).
function buildLTPrioritySlots(dates: string[], availableSessions: SessionRow[]): DateSessionSlot[] {
  const datesByWeekday = new Map<number, string[]>();
  for (const date of dates) {
    const wd = getWeekday(date);
    if (!datesByWeekday.has(wd)) datesByWeekday.set(wd, []);
    datesByWeekday.get(wd)!.push(date);
  }
  const nonToiSessions = availableSessions.filter((s) => classifyPeriod(s.StartTime) !== "Toi");
  const toiSessions = availableSessions.filter((s) => classifyPeriod(s.StartTime) === "Toi");

  const slotsForWeekdays = (weekdays: number[], sessions: SessionRow[]): DateSessionSlot[] =>
    weekdays.flatMap((wd) => (datesByWeekday.get(wd) || []).flatMap((date) => sessions.map((session) => ({ date, session }))));

  return [
    ...slotsForWeekdays([6, 0], nonToiSessions), // 1. T7 Sáng/Chiều, CN Sáng/Chiều
    ...slotsForWeekdays([4, 5], toiSessions),    // 2. Tối T5, Tối T6
    ...slotsForWeekdays([6], toiSessions),       // 3. Tối T7
    ...slotsForWeekdays([1, 2, 3], toiSessions), // 4. Tối T2, T3, T4
    // Tối CN (weekday 0, toiSessions) cố tình KHÔNG đưa vào.
  ];
}

// Việc BN/BO/BV: sinh danh sách (Ngày, Ca) khả dụng trong khung [rangeStart, rangeEnd] theo ĐÚNG thứ
// tự ưu tiên cần thử trước — vấn đề 1: Lâm sàng, và (Việc BV) block chỉ dùng phòng Sân bãi, KHÔNG được
// xếp Ca Tối (loại khỏi danh sách TRƯỚC khi tính slot, độc lập/chặt hơn checkTrainingModeRule — CQ/LT
// thường vẫn xếp Tối được nếu hợp lệ, riêng 2 trường hợp này thì không, bất kể hệ đào tạo); vấn đề 2:
// Lớp kiểu Liên thông theo đúng 4 nhóm ưu tiên của buildLTPrioritySlots ở trên — chỉ cần đổi thứ tự
// DANH SÁCH, tryPlaceSingleBlock vẫn duyệt tuần tự như cũ nên không cần đổi logic thử-xếp bên dưới.
function buildDateSessionSlots(ctx: RunContext, isClinical: boolean): DateSessionSlot[] {
  const dates: string[] = [];
  let cursor = ctx.rangeStart;
  while (cursor <= ctx.rangeEnd) {
    dates.push(cursor);
    cursor = shiftDateStr(cursor, 1);
  }

  const availableSessions = isClinical
    ? ctx.sessions.filter((s) => classifyPeriod(s.StartTime) !== "Toi")
    : ctx.sessions;

  if (ctx.trainingMode === "LT") {
    return buildLTPrioritySlots(dates, availableSessions);
  }
  return dates.flatMap((date) => availableSessions.map((session) => ({ date, session })));
}

// Dò (Ngày, Ca) theo ĐÚNG thứ tự ưu tiên đã sinh ở buildDateSessionSlots — với mỗi (Ngày, Ca) hợp lệ
// theo Hệ đào tạo (checkTrainingModeRule dùng như BỘ LỌC CỨNG ở đây, khác với xếp tay chỉ cảnh báo) và
// CHƯA bị chiếm (isSlotOccupied), thử từng GV (ưu tiên GV đang có ít giờ nhất trong lần chạy này) ×
// từng Phòng phù hợp — gọi ĐỦ các hàm kiểm tra đã có, pass hết thì tạo thật ngay (lưu ngay theo đúng
// chỉ đạo, không bọc transaction lớn).
async function tryPlaceSingleBlock(ctx: RunContext, params: PlaceBlockParams): Promise<{ success: boolean; scheduleId?: number }> {
  const slots = buildDateSessionSlots(ctx, params.isClinical ?? false);
  for (const { date, session } of slots) {
    const holiday = await findHoliday(date, ctx.trainingMode);
    if (holiday) continue;

    const endTime = addMinutesToTime(session.StartTime, params.periods * params.periodMinutes);
    if (endTime > session.EndTime) continue;

    const trainingCheck = await checkTrainingModeRule({ classId: ctx.classId, scheduleDate: date, startTime: session.StartTime });
    if (trainingCheck.violated) continue;

    const occupied = await isSlotOccupied(ctx.classId, date, session, params.groupLabel ?? null);
    if (occupied) continue;

    // Tối ưu hiệu năng QUAN TRỌNG: mọi phòng trong `eligibleRoomIds` CÙNG 1 nhóm loại phòng nên
    // checkSessionLength/checkDailyHoursLimit (chỉ phụ thuộc NHÓM loại phòng qua periodMinutes,
    // không phụ thuộc phòng cụ thể nào) cho ra CÙNG kết quả với BẤT KỲ phòng nào trong danh sách —
    // gọi 1 LẦN bằng phòng đại diện thay vì lặp lại cho từng phòng × từng GV, tránh hàng chục
    // nghìn lệnh gọi DB thừa khi khung Kỳ dài và có nhiều Phòng/GV khả dĩ.
    const representativeRoomId = params.eligibleRoomIds[0];
    // Ngoại lệ "ghép buổi cuối" (xem ghi chú maxPerSession ở PlaceBlockParams) — buổi Thực hành/Lâm
    // sàng đúng bằng maxPerSession + 1 tiết được PHÉP vượt giới hạn thường, bỏ qua checkSessionLength.
    const isMergedExceptionBlock = params.sessionType === "Practice" && params.periods === params.maxPerSession + 1;
    if (!isMergedExceptionBlock) {
      const sessionLengthCheck = await checkSessionLength({ roomId: representativeRoomId, startTime: session.StartTime, endTime });
      if (sessionLengthCheck.violated) continue;
    }

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

        // Việc BH: params.groupLabel chỉ có giá trị khi block này đến từ tryPlaceGroupSplitBlock —
        // lúc đó params.totalStudents ĐÃ là sĩ số riêng của 1 nhóm (perGroupSize tính sẵn ở đó), so
        // với sức chứa THẬT của phòng thay vì mốc chính sách.
        const capacityCheck = await checkRoomCapacity({
          roomId, totalStudents: params.totalStudents, isGroupSplit: !!params.groupLabel || !params.requiresGrouping,
        });
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

// Chia `total` tiết còn thiếu của 1 môn (Lý thuyết hoặc Thực hành/Lâm sàng) thành dãy các block
// (buổi) — tính TRỌN VẸN 1 LẦN cho toàn bộ phần còn lại của môn (không tính lại từng buổi riêng lẻ),
// để tránh buổi cuối cùng lệch quá nhiều so với các buổi khác:
// - Lý thuyết (mode="theory", max=5): nếu total chia max dư ĐÚNG 1 (vd 16 = 3×5+1) → KHÔNG tách
//   riêng buổi cuối 1 tiết, mà CHIA ĐỀU total ra đúng ceil(total/max) buổi (vd 16 → 4,4,4,4). Dư 0/2/3/4
//   giữ nguyên cách chia thông thường (max,max,...,phần dư).
// - Thực hành/Lâm sàng (mode="practice", max=4): nếu total chia max dư ĐÚNG 1 (vd 13 = 3×4+1) → GHÉP
//   phần dư 1 tiết đó vào buổi liền trước (vượt max, thành max+1 — ngoại lệ có chủ đích), vd 13 →
//   4,4,5 thay vì 4,4,4,1. Dư 0/2/3 giữ nguyên cách chia thông thường.
function computeBlockPlan(total: number, max: number, mode: "theory" | "practice"): number[] {
  if (total <= 0) return [];
  const numBlocks = Math.ceil(total / max);
  if (numBlocks <= 1) return [total];
  const remainder = total % max;
  if (remainder === 1) {
    if (mode === "theory") {
      const base = Math.floor(total / numBlocks);
      const extra = total - base * numBlocks;
      return Array.from({ length: numBlocks }, (_, i) => base + (i < extra ? 1 : 0));
    }
    return [...Array(numBlocks - 2).fill(max), max + 1];
  }
  return [...Array(numBlocks - 1).fill(max), total - max * (numBlocks - 1)];
}

// Xử lý 1 phần (Lý thuyết hoặc Thực hành) của 1 môn TRONG TUẦN đang xét: tính nhóm phòng, sĩ số/
// nhóm, rồi lặp xếp từng block trong khung tuần (ctx.rangeStart..ctx.rangeEnd).
//
// - KÍCH THƯỚC từng block lấy TỪ TRƯỚC theo `computeBlockPlan(wholeRemaining, ...)` (tính 1 lần cho
//   toàn bộ phần còn thiếu CẢ MÔN, không phải chỉ tiêu tuần) — để luôn cố xếp TRỌN VẸN tối đa cho
//   phép/buổi mà không tạo buổi cuối lệch bất hợp lý (Lý thuyết chia đều khi dư 1; Thực hành ghép buổi
//   cuối khi dư 1). Nếu kích thước đó không đặt được ở đâu trong tuần, giảm dần để thử, nhưng KHÔNG
//   giảm xuống dưới 2 tiết trừ khi block đó vốn đã là 1 tiết (chỉ xảy ra khi total còn lại đúng 1).
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
  let eligibleRoomIds = rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[roomCategory]?.includes(r.RoomType)).map((r) => r.RoomId);

  // Việc BR: buổi Thực hành/Lâm sàng — nếu môn đã gán riêng danh sách phòng phù hợp (SubjectRooms),
  // CHỈ được chọn trong đúng danh sách đó. Giao (intersect) với danh sách lọc theo RoomType ở trên
  // (không thay thế hẳn) để vẫn tôn trọng đúng loại phòng cần dùng dù lỡ gán nhầm phòng khác loại.
  // Môn chưa cấu hình (getSubjectRoomIds rỗng) giữ nguyên danh sách theo RoomType như trước.
  if (sessionType === "Practice") {
    const subjectRoomIds = await getSubjectRoomIds(task.subjectId);
    if (subjectRoomIds.length > 0) {
      eligibleRoomIds = eligibleRoomIds.filter((id) => subjectRoomIds.includes(id));
    }
  }

  if (eligibleRoomIds.length === 0) {
    const label = roomCategory === "LyThuyet" ? "Lý thuyết" : roomCategory === "LamSang" ? "Lâm sàng" : "Thực hành";
    return { scheduled: 0, failureReason: `Không có phòng ${label} nào khả dụng` };
  }

  // Việc BV: TOÀN BỘ phòng khả dụng của block này là Sân bãi (vd Giáo dục thể chất đã gán riêng
  // SubjectRooms toàn Sân bãi) — không phù hợp học buổi Tối, loại Ca Tối giống nguyên tắc Lâm sàng.
  const isAllSanBai = eligibleRoomIds.every((id) => rooms.find((r) => r.RoomId === id)?.RoomType === "SanBai");

  const periodMinutes = await getPeriodMinutes(roomCategory);
  const maxPerSessionKey = sessionType === "Theory" ? "MaxTheoryHoursPerSession" : "MaxPracticeHoursPerSession";
  const maxPerSession = await getPolicyValue(maxPerSessionKey);
  // Việc BH: số nhóm cần tách cho Thực hành/Lâm sàng dùng bảng mốc cố định getRequiredGroupCount
  // (không còn chia trần theo policy MaxStudentsPerPracticeGroup/MaxStudentsPerClinicalGroup) — Lý
  // thuyết không thuộc phạm vi bảng mốc này, giữ nguyên cách tính cũ theo MaxStudentsPerTheoryRoom.
  // Việc BT: môn Thực hành/Lâm sàng có thể KHÔNG cần chia nhóm (Subjects.RequiresGrouping = 0) — bỏ
  // qua hoàn toàn bảng mốc sĩ số, luôn 1 nhóm duy nhất (cả lớp học chung). Không áp dụng cho Lý thuyết
  // (roomCategory LyThuyet không thuộc phạm vi tính năng này).
  const requiresGrouping = (roomCategory === "ThucHanh" || roomCategory === "LamSang")
    ? await getSubjectRequiresGrouping(task.subjectId)
    : true;
  let groupCount: number;
  if (roomCategory === "ThucHanh") {
    groupCount = requiresGrouping ? getRequiredGroupCount(classSize, "Practice") : 1;
  } else if (roomCategory === "LamSang") {
    groupCount = requiresGrouping ? getRequiredGroupCount(classSize, "Clinical") : 1;
  } else {
    const capacityLimit = await getPolicyValue(CAPACITY_POLICY_BY_ROOM_TYPE[roomCategory]);
    groupCount = classSize > capacityLimit ? Math.ceil(classSize / capacityLimit) : 1;
  }

  const blockPlan = computeBlockPlan(wholeRemaining, maxPerSession, sessionType === "Theory" ? "theory" : "practice");
  let scheduled = 0;
  let left = wholeRemaining;
  let planIndex = 0;
  while (scheduled < quotaThisWeek && left > 0) {
    // Hết block đã hoạch định trước (computeBlockPlan) nhưng vẫn còn thiếu tiết — xảy ra khi 1 block
    // trong kế hoạch phải co lại lúc đặt (vd ngoại lệ "ghép buổi 5 tiết Thực hành" không có Ca nào đủ
    // dài để chứa, phải co xuống 4) khiến phần dư của block đó CHƯA được xếp. Dùng lại cách tính
    // thông thường (MIN phần còn lại, giới hạn tối đa/buổi) để tiếp tục xếp nốt, không bỏ sót tiết.
    let blockSize = planIndex < blockPlan.length ? blockPlan[planIndex] : Math.min(left, maxPerSession);
    const minBlockSize = blockSize === 1 ? 1 : 2;
    let placed = false;
    while (blockSize >= minBlockSize) {
      const params: PlaceBlockParams = {
        subjectId: task.subjectId, sessionType, periods: blockSize, periodMinutes,
        eligibleRoomIds, teacherIds: task.teacherIds, totalStudents: classSize,
        isClinical: roomCategory === "LamSang" || isAllSanBai, maxPerSession, requiresGrouping,
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
    planIndex++;
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
    .query<{ SubjectId: number; SubjectName: string; PracticeMode: string; Category: string | null }>(`
      WITH ranked AS (
        SELECT ci.SubjectId, ci.PracticeMode,
               ROW_NUMBER() OVER (PARTITION BY ci.SubjectId ORDER BY CASE WHEN ci.CohortId = @cohortId THEN 0 ELSE 1 END) AS rn
        FROM CurriculumItems ci
        WHERE ci.MajorId = @majorId AND ci.TermNumber = @termNumber AND ci.IsActive = 1
          AND (ci.CohortId = @cohortId OR ci.CohortId IS NULL)
      )
      SELECT r.SubjectId, sub.SubjectName, r.PracticeMode, sub.Category
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
        category: row.Category,
        theoryRemaining: Math.max(0, targets.theoryTarget - theoryDone),
        practiceRemaining: Math.max(0, targets.practiceTarget - practiceDone),
        teacherIds: teacherResult.recordset.map((t) => t.TeacherId),
      };
    })
  );

  const rooms = roomsResult.recordset;

  // Việc BK: chỉ tiêu tuần (Math.ceil(số tiết còn thiếu / số tuần còn lại), tính riêng Lý thuyết +
  // Thực hành rồi cộng lại) — dùng LÀM CHUNG cho cả sắp xếp thứ tự xử lý VÀ giới hạn số tiết/tuần ở
  // vòng lặp chính bên dưới, tránh 2 nơi tính lệch nhau.
  function computeQuotas(task: SubjectTask): { theoryQuota: number; practiceQuota: number } {
    return {
      theoryQuota: task.theoryRemaining > 0 ? Math.ceil(task.theoryRemaining / weeksRemaining) : 0,
      practiceQuota: task.practiceRemaining > 0 ? Math.ceil(task.practiceRemaining / weeksRemaining) : 0,
    };
  }

  // Việc BK: sắp xếp môn xử lý TRONG TUẦN NÀY theo mức độ CẤP BÁCH (chỉ tiêu tuần = theoryQuota +
  // practiceQuota) GIẢM DẦN — môn càng "đuối" so với thời gian còn lại (còn thiếu nhiều tiết/tuần)
  // càng được xử lý TRƯỚC, xếp trọn vẹn tối đa 1 buổi trước khi tới môn tiếp theo. Nhờ vậy môn NẶNG
  // (vd 90-100 tiết) sẽ tự động có chỉ tiêu tuần cao ngay từ Tuần 1, luôn được ưu tiên xử lý sớm và
  // đều đặn mỗi tuần — không bị các môn nhẹ hơn chiếm hết slot trước rồi dồn hết vào cuối Kỳ (vấn đề
  // đã phát hiện với cách sắp cũ theo độ khan hiếm GV/phòng, vốn KHÔNG đổi theo tiến độ từng tuần nên
  // giữ nguyên 1 thứ tự cố định suốt cả Kỳ). Category chỉ còn là tiêu chí PHỤ để phá thế hòa khi 2 môn
  // có chỉ tiêu tuần bằng nhau, không còn là tiêu chí chính chặn cứng thứ tự.
  const CATEGORY_ORDER: Record<string, number> = { DaiCuong: 0, CoSoNganh: 1, ChuyenNganh: 2 };
  function urgency(task: SubjectTask): number {
    const { theoryQuota, practiceQuota } = computeQuotas(task);
    return theoryQuota + practiceQuota;
  }
  subjectTasks.sort((a, b) => {
    const urgencyDiff = urgency(b) - urgency(a);
    if (urgencyDiff !== 0) return urgencyDiff;
    const catDiff = (CATEGORY_ORDER[a.category ?? ""] ?? 99) - (CATEGORY_ORDER[b.category ?? ""] ?? 99);
    if (catDiff !== 0) return catDiff;
    return a.subjectId - b.subjectId;
  });

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

    // Chỉ tiêu TUẦN NÀY (computeQuotas — cùng công thức đã dùng để sắp thứ tự xử lý môn ở trên) dùng
    // CHO 2 việc: (1) quyết định phần nào (Lý thuyết/Thực hành) của môn này được XÉT xử lý trong
    // tuần đang chạy — quota luôn > 0 khi phần đó còn thiếu; (2) làm giới hạn TỔNG SỐ TIẾT xếp được
    // của phần đó TRONG TUẦN NÀY (vòng lặp ngoài của processSubjectPart dừng khi đạt quota) — đây là
    // phần tự sửa lại so với bản đầu: thử bỏ hẳn giới hạn này (chỉ dùng quota để bật/tắt xét môn,
    // không chặn số tiết) và test thật cho thấy 1-2 môn xử lý trước chiếm hết slot cả tuần, các môn
    // còn lại nhận 0 tiết — sai với tinh thần "xếp dần đều qua các tuần". Nên quota vẫn cần chặn TỔNG
    // số tiết/tuần để công bằng giữa các môn — Việc BK giải quyết vấn đề "dồn cục cuối Kỳ" bằng cách
    // đổi THỨ TỰ xử lý môn (ưu tiên môn cấp bách nhất trước) chứ không đổi cơ chế quota này.
    // KÍCH THƯỚC 1 BLOCK: processSubjectPart không tính blockSize từ quota mà tính từ phần còn thiếu
    // CẢ MÔN (task.theoryRemaining/practiceRemaining) — luôn cố xếp TRỌN VẸN tối đa/buổi thay vì cắt
    // nhỏ theo chỉ tiêu tuần — nên block cuối cùng của 1 môn trong tuần vẫn có thể NHỈNH hơn quota một
    // chút (quota không cắt giữa block), chỉ không được nhỏ hơn giới hạn tối thiểu 2 tiết (trừ khi còn
    // đúng 1 tiết cuối cùng của cả môn).
    // periodsNeeded/periodsScheduled báo cáo theo phần còn thiếu THẬT của cả môn (không phải theo
    // chỉ tiêu tuần).
    const { theoryQuota, practiceQuota } = computeQuotas(task);
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
    // Việc BM (vấn đề 1): CHỈ xếp Thực hành/Lâm sàng khi Lý thuyết CẢ KỲ của ĐÚNG môn này đã xong
    // (task.theoryRemaining — tính TỪ DB TRƯỚC khi chạy tuần này — bằng 0) — sai sư phạm nếu học Thực
    // hành trước khi xong Lý thuyết. Cố tình dùng giá trị theoryRemaining TRƯỚC tuần này (không phải
    // recompute sau khi vừa xếp Lý thuyết ở trên) — nếu Lý thuyết chỉ vừa xong TRONG tuần này thì vẫn
    // dời Thực hành sang tuần sau, tránh Thực hành bị xếp vào ngày SỚM HƠN buổi Lý thuyết cuối cùng
    // trong cùng tuần. Chỉ áp dụng cho ĐÚNG môn này — không ảnh hưởng môn khác (mỗi môn có
    // theoryRemaining riêng, môn A có thể đang xếp Thực hành trong khi môn B vẫn đang xếp Lý thuyết).
    if (practiceQuota > 0 && task.theoryRemaining > 0) {
      reasons.push(`Chưa xếp Thực hành/Lâm sàng — còn thiếu ${task.theoryRemaining} tiết Lý thuyết cần học xong trước`);
    } else if (practiceQuota > 0) {
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
