import { sql, getPool } from "../config/db";
import { getPolicyValue } from "./policyConfig";

// Sĩ số tối đa theo loại phòng (Việc Q) và số giờ Lý thuyết/Thực hành mỗi buổi & mỗi ngày (Việc S)
// đều lấy từ SchedulingPolicy — KHÔNG hard-code số, chỉ hard-code TÊN policy key.

const CAPACITY_POLICY_BY_ROOM_TYPE: Record<string, string> = {
  LyThuyet: "MaxStudentsPerTheoryRoom",
  ThucHanh: "MaxStudentsPerPracticeGroup",
  LamSang: "MaxStudentsPerClinicalGroup",
};

const ROOM_TYPE_LABEL: Record<string, string> = {
  LyThuyet: "Phòng lý thuyết",
  ThucHanh: "Phòng thực hành",
  LamSang: "Phòng lâm sàng",
};

interface RoomInfo {
  RoomType: string;
  RoomName: string;
}

async function getRoomInfo(roomId: number): Promise<RoomInfo | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("roomId", sql.Int, roomId)
    .query<RoomInfo>(`SELECT RoomType, RoomName FROM Rooms WHERE RoomId = @roomId`);
  return result.recordset[0] || null;
}

export async function getClassSize(classId: number): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .query<{ ClassSize: number }>(`SELECT ClassSize FROM Classes WHERE ClassId = @classId`);
  return result.recordset[0]?.ClassSize ?? 0;
}

interface CapacityCheckParams {
  roomId: number;
  totalStudents: number;
}
interface CapacityCheckResult {
  violated: boolean;
  message?: string;
}

// Việc Q: sĩ số/ca vượt giới hạn theo loại phòng — VI PHẠM CỨNG (chặn lưu), gợi ý tách nhóm.
export async function checkRoomCapacity({ roomId, totalStudents }: CapacityCheckParams): Promise<CapacityCheckResult> {
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false };

  const policyKey = CAPACITY_POLICY_BY_ROOM_TYPE[room.RoomType];
  if (!policyKey) return { violated: false };

  const maxStudents = await getPolicyValue(policyKey);
  if (totalStudents > maxStudents) {
    const label = ROOM_TYPE_LABEL[room.RoomType] || room.RoomType;
    return {
      violated: true,
      message: `${label} tối đa ${maxStudents} người/ca, buổi này có ${totalStudents} người — cần tách nhóm (dùng nhãn nhóm khi xếp lịch)`,
    };
  }
  return { violated: false };
}

export type SessionCategory = "LyThuyet" | "ThucHanh";

// Việc AV: LyThuyet/SanBai tính là Lý thuyết; ThucHanh/Labo/LamSang tính là Thực hành — đồng bộ
// với cách getPeriodMinutes đã nhóm loại phòng (trước đây SanBai/Labo bị bỏ sót, trả về null, khiến
// checkSessionLength/checkDailyHoursLimit âm thầm bỏ qua các buổi dùng phòng loại này).
export function classifyRoomCategory(roomType: string): SessionCategory | null {
  if (roomType === "LyThuyet" || roomType === "SanBai") return "LyThuyet";
  if (roomType === "ThucHanh" || roomType === "Labo" || roomType === "LamSang") return "ThucHanh";
  return null;
}

export function diffMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

function categoryLabel(category: SessionCategory): string {
  return category === "LyThuyet" ? "Lý thuyết" : "Thực hành/Lâm sàng";
}

interface SessionLengthCheckParams {
  roomId: number;
  startTime: string;
  endTime: string;
}
interface SessionLengthCheckResult {
  violated: boolean;
  message?: string;
}

// Việc S (1/2) + Việc AX (fix đơn vị): 1 buổi không nên dài quá MaxTheoryHoursPerSession /
// MaxPracticeHoursPerSession — CHẶN CỨNG. So sánh theo TIẾT (không phải giờ đồng hồ thô): trường
// tính định mức 1 buổi theo số tiết, mà TheoryPeriodMinutes (45p) khác PracticePeriodMinutes
// (60p) — nếu so bằng giờ thô thì 6 tiết Lý thuyết chỉ = 4.5 giờ, lọt qua giới hạn "5 giờ" dù thực
// tế đã vượt 5 tiết. Tên policy key giữ nguyên (MaxTheoryHoursPerSession...) để không phải đổi dữ
// liệu SchedulingPolicy đã có, nhưng giá trị nay được hiểu là SỐ TIẾT tối đa/buổi.
export async function checkSessionLength({ roomId, startTime, endTime }: SessionLengthCheckParams): Promise<SessionLengthCheckResult> {
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false };
  const category = classifyRoomCategory(room.RoomType);
  if (!category) return { violated: false };

  const minutes = diffMinutes(startTime, endTime);
  const periodMinutes = await getPeriodMinutes(room.RoomType);
  const periods = minutes / periodMinutes;
  const maxPeriodsKey = category === "LyThuyet" ? "MaxTheoryHoursPerSession" : "MaxPracticeHoursPerSession";
  const maxPeriods = await getPolicyValue(maxPeriodsKey);

  if (periods > maxPeriods) {
    return {
      violated: true,
      message: `Buổi ${categoryLabel(category)} dài ${periods.toFixed(1)} tiết, vượt giới hạn ${maxPeriods} tiết/buổi`,
    };
  }
  return { violated: false };
}

interface DailyHoursCheckParams {
  classId: number;
  scheduleDate: string;
  roomId: number;
  startTime: string;
  endTime: string;
  excludeScheduleId?: number | null;
  excludeMergedSessionId?: number | null;
}
interface DailyHoursCheckResult {
  violated: boolean;
  message?: string;
}

// Việc S (2/2) + Việc AX (fix đơn vị): tổng số TIẾT Lý thuyết/Thực hành của 1 Lớp trong 1 NGÀY
// không quá MaxTheoryHoursPerDay / MaxPracticeHoursPerDay (tính cả các Schedule khác đã có cùng
// lớp, cùng ngày, cùng nhóm loại phòng) — CHẶN CỨNG, cùng lý do đổi đơn vị như checkSessionLength.
export async function checkDailyHoursLimit({
  classId,
  scheduleDate,
  roomId,
  startTime,
  endTime,
  excludeScheduleId = null,
  excludeMergedSessionId = null,
}: DailyHoursCheckParams): Promise<DailyHoursCheckResult> {
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false };
  const category = classifyRoomCategory(room.RoomType);
  if (!category) return { violated: false };

  // Việc AX (fix): trước đây bỏ sót SanBai/Labo khỏi danh sách — 2 loại phòng này không được tính
  // vào tổng giờ/ngày, để lọt được thêm buổi mà không bị chặn. Đồng bộ với classifyRoomCategory.
  const roomTypesInCategory = category === "LyThuyet" ? ["LyThuyet", "SanBai"] : ["ThucHanh", "Labo", "LamSang"];
  const pool = await getPool();
  const request = pool
    .request()
    .input("classId", sql.Int, classId)
    .input("date", sql.Date, scheduleDate)
    .input("excludeId", sql.Int, excludeScheduleId)
    .input("excludeMergedId", sql.Int, excludeMergedSessionId);
  const placeholders = roomTypesInCategory
    .map((rt, i) => {
      request.input(`rt${i}`, sql.NVarChar, rt);
      return `@rt${i}`;
    })
    .join(", ");

  const existingResult = await request.query<{ StartTime: string; EndTime: string }>(`
    SELECT CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
    FROM Schedule s
    INNER JOIN Rooms r ON r.RoomId = s.RoomId
    WHERE s.ClassId = @classId AND s.ScheduleDate = @date AND r.RoomType IN (${placeholders})
      AND (@excludeId IS NULL OR s.ScheduleId <> @excludeId)
      AND (@excludeMergedId IS NULL OR s.MergedSessionId IS NULL OR s.MergedSessionId <> @excludeMergedId)
  `);

  // Mọi loại phòng trong CÙNG 1 nhóm (LyThuyet+SanBai hoặc ThucHanh+Labo+LamSang) luôn dùng chung 1
  // độ dài tiết (getPeriodMinutes nhóm y hệt classifyRoomCategory) nên quy đổi 1 lần theo phòng
  // hiện tại là đủ, không cần tra riêng từng dòng lịch sử.
  const periodMinutes = await getPeriodMinutes(room.RoomType);
  const existingMinutes = existingResult.recordset.reduce((sum, r) => sum + diffMinutes(r.StartTime, r.EndTime), 0);
  const totalMinutes = existingMinutes + diffMinutes(startTime, endTime);
  const totalPeriods = totalMinutes / periodMinutes;

  const maxPeriodsKey = category === "LyThuyet" ? "MaxTheoryHoursPerDay" : "MaxPracticeHoursPerDay";
  const maxPeriods = await getPolicyValue(maxPeriodsKey);

  if (totalPeriods > maxPeriods) {
    return {
      violated: true,
      message: `Tổng số tiết ${categoryLabel(category)} ngày ${scheduleDate} của lớp là ${totalPeriods.toFixed(1)} tiết, vượt giới hạn ${maxPeriods} tiết/ngày`,
    };
  }
  return { violated: false };
}

// Việc AU: độ dài 1 tiết theo loại Phòng — cùng quy ước với Việc AS (Lý thuyết dùng
// TheoryPeriodMinutes, Thực hành/Labo/Lâm sàng dùng PracticePeriodMinutes, Sân bãi mặc định
// theo giờ Lý thuyết).
export async function getPeriodMinutes(roomType: string): Promise<number> {
  if (roomType === "ThucHanh" || roomType === "Labo" || roomType === "LamSang") {
    return getPolicyValue("PracticePeriodMinutes");
  }
  return getPolicyValue("TheoryPeriodMinutes");
}

export interface SubjectPeriodTargets {
  theoryTarget: number;
  practiceTarget: number;
}

// Việc AV: sửa lỗi nghiêm trọng — trước đây gộp Lý thuyết + Thực hành (+ cả giờ Thi) thành 1 tổng
// duy nhất, nên 1 môn xếp toàn bộ giờ Lý thuyết (chưa xếp phút Thực hành nào) vẫn có thể bị tính
// "đủ tổng" và báo nhầm đủ điều kiện thi. Nay trả về 2 chỉ tiêu RIÊNG: theoryTarget/practiceTarget
// — lấy từ CurriculumItems.TheoryHours/PracticeHours (ưu tiên dòng ghi đè riêng theo Khóa, COALESCE
// TỪNG CỘT để 1 dòng ghi đè chỉ 1 phần vẫn fallback đúng cột còn thiếu), fallback về
// Subjects.TheoryHours/PracticeHours nếu môn chưa có trong khung chương trình. KHÔNG tính ExamHours
// vào đây — đó là giờ thi, không phải giờ học, không thuộc "tiến độ đã học".
export async function getTotalPeriodsForSubject(
  majorId: number, subjectId: number, cohortId: number | null, termNumber: number | null
): Promise<SubjectPeriodTargets> {
  const pool = await getPool();
  let theoryTarget: number | null = null;
  let practiceTarget: number | null = null;

  if (termNumber != null) {
    const ciResult = await pool
      .request()
      .input("majorId", sql.Int, majorId)
      .input("subjectId", sql.Int, subjectId)
      .input("termNumber", sql.Int, termNumber)
      .input("cohortId", sql.Int, cohortId)
      .query<{ TheoryHours: number | null; PracticeHours: number | null }>(`
        SELECT TOP 1 COALESCE(ci.TheoryHours, sub.TheoryHours) AS TheoryHours,
               COALESCE(ci.PracticeHours, sub.PracticeHours) AS PracticeHours
        FROM CurriculumItems ci
        INNER JOIN Subjects sub ON sub.SubjectId = ci.SubjectId
        WHERE ci.MajorId = @majorId AND ci.SubjectId = @subjectId AND ci.TermNumber = @termNumber
          AND (ci.CohortId = @cohortId OR ci.CohortId IS NULL)
        ORDER BY CASE WHEN ci.CohortId = @cohortId THEN 0 ELSE 1 END
      `);
    const row = ciResult.recordset[0];
    if (row) {
      theoryTarget = row.TheoryHours;
      practiceTarget = row.PracticeHours;
    }
  }

  if (theoryTarget == null || practiceTarget == null) {
    const subResult = await pool
      .request()
      .input("subjectId", sql.Int, subjectId)
      .query<{ TheoryHours: number; PracticeHours: number }>(`SELECT TheoryHours, PracticeHours FROM Subjects WHERE SubjectId = @subjectId`);
    const row = subResult.recordset[0];
    if (theoryTarget == null) theoryTarget = row?.TheoryHours ?? 0;
    if (practiceTarget == null) practiceTarget = row?.PracticeHours ?? 0;
  }

  return { theoryTarget, practiceTarget };
}

export interface PeriodTimelineEntry {
  scheduleId: number;
  category: SessionCategory | null;
  periodsThisSession: number;
  cumulativeTheoryPeriods: number;
  cumulativePracticePeriods: number;
}

// Việc AU (fix) + Việc AV: mỗi buổi trong 1 Lớp + 1 Môn có tiến độ LŨY KẾ RIÊNG theo đúng thứ tự
// thời gian của nó (buổi diễn ra trước cộng dồn ít hơn buổi diễn ra sau), và lũy kế Lý thuyết /
// Thực hành được tính TÁCH BIỆT theo loại phòng của từng buổi (classifyRoomCategory) — 1 buổi chỉ
// cộng vào ĐÚNG 1 trong 2 dòng lũy kế, không cộng chung như bản trước (gây lỗi báo nhầm đủ điều
// kiện thi dù mới xếp toàn Lý thuyết, chưa xếp Thực hành nào).
export async function getPeriodTimelineForSubject(classId: number, subjectId: number): Promise<PeriodTimelineEntry[]> {
  const pool = await getPool();
  const rowsResult = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("subjectId", sql.Int, subjectId)
    .query<{ ScheduleId: number; RoomType: string; StartTime: string; EndTime: string }>(`
      SELECT s.ScheduleId, r.RoomType, CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
      FROM Schedule s
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      WHERE s.ClassId = @classId AND s.SubjectId = @subjectId
      ORDER BY s.ScheduleDate, s.StartTime, s.ScheduleId
    `);

  const periodMinutesCache = new Map<string, number>();
  let cumulativeTheory = 0;
  let cumulativePractice = 0;
  const timeline: PeriodTimelineEntry[] = [];
  for (const row of rowsResult.recordset) {
    let periodMinutes = periodMinutesCache.get(row.RoomType);
    if (periodMinutes === undefined) {
      periodMinutes = await getPeriodMinutes(row.RoomType);
      periodMinutesCache.set(row.RoomType, periodMinutes);
    }
    const periods = diffMinutes(row.StartTime, row.EndTime) / periodMinutes;
    const category = classifyRoomCategory(row.RoomType);
    if (category === "LyThuyet") cumulativeTheory += periods;
    else if (category === "ThucHanh") cumulativePractice += periods;
    timeline.push({
      scheduleId: row.ScheduleId,
      category,
      periodsThisSession: Math.round(periods * 10) / 10,
      cumulativeTheoryPeriods: Math.round(cumulativeTheory * 10) / 10,
      cumulativePracticePeriods: Math.round(cumulativePractice * 10) / 10,
    });
  }
  return timeline;
}
