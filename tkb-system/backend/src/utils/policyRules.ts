import { sql, getPool } from "../config/db";
import { getPolicyValue } from "./policyConfig";

// Sĩ số tối đa theo loại phòng (Việc Q) và số giờ Lý thuyết/Thực hành mỗi buổi & mỗi ngày (Việc S)
// đều lấy từ SchedulingPolicy — KHÔNG hard-code số, chỉ hard-code TÊN policy key.

// Export để autoScheduler.ts tái sử dụng đúng bảng tra policy-key-theo-loại-phòng (nhóm phòng nào
// dùng chính sách sĩ số nào), không định nghĩa lại.
export const CAPACITY_POLICY_BY_ROOM_TYPE: Record<string, string> = {
  LyThuyet: "MaxStudentsPerTheoryRoom",
  ThucHanh: "MaxStudentsPerPracticeGroup",
  LamSang: "MaxStudentsPerClinicalGroup",
};

// Việc BA/BB (ban đầu chỉ có ở frontend ScheduleGrid.tsx) — port sang backend để autoScheduler.ts
// dùng chung, tránh định nghĩa lại logic suy ra nhóm loại phòng từ PracticeMode+SessionType.
export const ROOM_TYPES_BY_CATEGORY: Record<string, string[]> = {
  LyThuyet: ["LyThuyet", "SanBai"],
  ThucHanh: ["ThucHanh", "Labo"],
  LamSang: ["LamSang"],
};

export function roomCategoryFor(practiceMode: string | null, sessionType: "Theory" | "Practice"): string {
  if (sessionType === "Theory") return "LyThuyet";
  if (practiceMode === "LyThuyet") return "LyThuyet";
  if (practiceMode === "LamSang") return "LamSang";
  return "ThucHanh";
}

// Việc BH: bảng mốc số nhóm CỐ ĐỊNH theo sĩ số lớp, do nhà trường quyết định — thay hoàn toàn công
// thức chia trần Math.ceil(sĩ số / MaxStudentsPerPracticeGroup(10)|MaxStudentsPerClinicalGroup(15))
// dùng trước đây. Nhà trường CHẤP NHẬN số người/nhóm thực tế có thể vượt nhẹ mức 10/15 cũ để giảm số
// nhóm cần thiết, đỡ tốn phòng/giảng viên. Đây KHÔNG lấy từ SchedulingPolicy vì là bảng cố định theo
// quyết định hành chính, không phải tham số vận hành hay đổi — nếu nhà trường điều chỉnh mốc sau
// này, chỉ cần sửa các ngưỡng if/else dưới đây (ngoài mốc 35 đã có sẵn, các mốc cao hơn nối tiếp
// đúng bước của bảng gốc — 10 người/nhóm với Thực hành, 20 người/nhóm với Lâm sàng — vì thực tế
// hiện chưa có lớp nào vượt 35 người).
export function getRequiredGroupCount(classSize: number, sessionType: "Practice" | "Clinical"): number {
  if (sessionType === "Practice") {
    if (classSize <= 15) return 1;
    if (classSize <= 25) return 2;
    if (classSize <= 35) return 3;
    return 3 + Math.ceil((classSize - 35) / 10);
  }
  if (classSize <= 15) return 1;
  if (classSize <= 35) return 2;
  return 2 + Math.ceil((classSize - 35) / 20);
}

const ROOM_TYPE_LABEL: Record<string, string> = {
  LyThuyet: "Phòng lý thuyết",
  ThucHanh: "Phòng thực hành",
  LamSang: "Phòng lâm sàng",
};

export interface RoomInfo {
  RoomType: string;
  RoomName: string;
  Capacity: number | null;
}

// Việc BH: export để scheduleController.ts tra RoomType/Capacity thật của phòng đã chọn khi cần tính
// sĩ số/nhóm cho 1 dòng Schedule đã tách nhóm (GroupLabel khác NULL) — tránh viết lại truy vấn.
export async function getRoomInfo(roomId: number): Promise<RoomInfo | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("roomId", sql.Int, roomId)
    .query<RoomInfo>(`SELECT RoomType, RoomName, Capacity FROM Rooms WHERE RoomId = @roomId`);
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
  // Việc BH: true khi dòng Schedule đang kiểm tra ĐÃ tách nhóm (GroupLabel khác NULL) — lúc đó
  // totalStudents là sĩ số THỰC TẾ của RIÊNG nhóm đó (không phải cả lớp, caller tự tính bằng
  // getRequiredGroupCount trước khi gọi hàm này), so với SỨC CHỨA THẬT của phòng đã chọn
  // (Rooms.Capacity) — giới hạn vật lý thực sự cần tôn trọng. KHÔNG còn so với mốc chính sách
  // MaxStudentsPerPracticeGroup/MaxStudentsPerClinicalGroup nữa cho trường hợp này (2 mốc đó giờ chỉ
  // còn dùng để QUYẾT ĐỊNH cần tách bao nhiêu nhóm qua getRequiredGroupCount).
  isGroupSplit?: boolean;
}
interface CapacityCheckResult {
  violated: boolean;
  message?: string;
}

// Việc Q: sĩ số/ca vượt giới hạn theo loại phòng — VI PHẠM CỨNG (chặn lưu), gợi ý tách nhóm.
// Việc BH: buổi ĐÃ tách nhóm (isGroupSplit) so với sức chứa THẬT của phòng thay vì mốc chính sách.
export async function checkRoomCapacity({ roomId, totalStudents, isGroupSplit }: CapacityCheckParams): Promise<CapacityCheckResult> {
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false };

  if (isGroupSplit) {
    if (room.Capacity == null) return { violated: false };
    if (totalStudents > room.Capacity) {
      return {
        violated: true,
        message: `Phòng ${room.RoomName} sức chứa tối đa ${room.Capacity} người, nhóm này có ${totalStudents} người — chọn phòng khác hoặc tách thêm nhóm`,
      };
    }
    return { violated: false };
  }

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

// Việc BR: danh sách RoomId đã gán riêng cho 1 môn (rỗng = chưa cấu hình, dùng phương án dự phòng
// lọc theo RoomType chung) — export để autoScheduler.ts lọc eligibleRoomIds, tránh viết lại truy vấn.
export async function getSubjectRoomIds(subjectId: number): Promise<number[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("subjectId", sql.Int, subjectId)
    .query<{ RoomId: number }>(`SELECT RoomId FROM SubjectRooms WHERE SubjectId = @subjectId`);
  return result.recordset.map((r) => r.RoomId);
}

interface SubjectRoomCheckParams {
  subjectId: number;
  roomId: number;
  sessionType?: string | null;
}
interface SubjectRoomCheckResult {
  violated: boolean;
  message?: string;
}

// Việc BR: Môn học có thể gán riêng danh sách Phòng Thực hành/Lâm sàng CỤ THỂ (bảng SubjectRooms) —
// nếu môn ĐÃ có ít nhất 1 dòng trong SubjectRooms, phòng chọn để xếp PHẢI nằm trong đúng danh sách đó
// (không được chọn phòng khác dù cùng loại RoomType). Môn CHƯA cấu hình (0 dòng, đa số 285 môn hiện
// tại) — coi như chưa ràng buộc riêng, KHÔNG chặn gì thêm ở đây, dùng phương án dự phòng lọc theo
// RoomType chung như trước (ROOM_TYPES_BY_CATEGORY). CHỈ áp dụng cho buổi Thực hành/Lâm sàng
// (sessionType === "Practice") — Lý thuyết không thuộc phạm vi tính năng này.
export async function checkSubjectRoom({ subjectId, roomId, sessionType }: SubjectRoomCheckParams): Promise<SubjectRoomCheckResult> {
  if (sessionType !== "Practice") return { violated: false };

  const pool = await getPool();
  const assignedResult = await pool
    .request()
    .input("subjectId", sql.Int, subjectId)
    .query<{ RoomId: number; RoomName: string }>(`
      SELECT sr.RoomId, r.RoomName FROM SubjectRooms sr
      INNER JOIN Rooms r ON r.RoomId = sr.RoomId
      WHERE sr.SubjectId = @subjectId
    `);
  if (assignedResult.recordset.length === 0) return { violated: false };

  if (assignedResult.recordset.some((r) => r.RoomId === roomId)) return { violated: false };

  const roomNames = assignedResult.recordset.map((r) => r.RoomName).join(", ");
  return {
    violated: true,
    message: `Môn học này chỉ được xếp ở phòng đã gán riêng: ${roomNames} — chọn đúng phòng đã gán cho môn`,
  };
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

  // Việc BO: DISTINCT theo (StartTime, EndTime) — 1 buổi Tách nhóm (nhiều nhóm học song song ở
  // nhiều phòng cùng lúc, kể cả khác môn theo Việc BM vấn đề 2) tạo NHIỀU dòng Schedule cùng khung
  // giờ, nhưng với học sinh chỉ tốn ĐÚNG 1 khung giờ đó trong ngày — không nhân đôi/ba theo số nhóm.
  // Trước đây SUM thẳng từng dòng khiến 1 buổi 3 nhóm song song bị tính thành 3x thời lượng thật,
  // khiến tổng giờ/ngày vượt ngưỡng ảo, chặn nhầm các buổi hợp lệ xử lý SAU trong cùng ngày (chẩn
  // đoán qua log chi tiết + đối chiếu dữ liệu thật: Sáng Chủ nhật tách 2 nhóm song song bị tính gấp
  // đôi, khiến Chiều Chủ nhật cùng ngày luôn bị chặn dù còn trống thật).
  const existingResult = await request.query<{ StartTime: string; EndTime: string }>(`
    SELECT DISTINCT CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
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
  // Block đang kiểm tra có thể chính là 1 NHÓM SONG SONG khác của 1 khung giờ ĐÃ có sẵn trong
  // existingResult (vd đang xét Nhóm 2 trong khi Nhóm 1 của cùng buổi đã lưu trước đó) — nếu khung
  // giờ trùng khớp hoàn toàn, KHÔNG cộng thêm lần nữa (đã tính trong existingMinutes rồi).
  const candidateAlreadyCounted = existingResult.recordset.some((r) => r.StartTime === startTime && r.EndTime === endTime);
  const totalMinutes = candidateAlreadyCounted ? existingMinutes : existingMinutes + diffMinutes(startTime, endTime);
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
// Việc BA: 1 buổi Thực hành có thể được dạy TẠI phòng Lý thuyết (PracticeMode=LyThuyet của môn) —
// lúc này classifyRoomCategory(RoomType) sẽ suy nhầm ra "LyThuyet" dù buổi đó phải tính vào chỉ
// tiêu Thực hành. Vì vậy phải ƯU TIÊN Schedule.SessionType ("Theory"/"Practice", do người dùng chọn
// tường minh ở "Loại buổi học" khi xếp lịch) để xác định LOẠI buổi (chỉ tiêu nào được cộng), chỉ
// fallback về suy luận theo RoomType (như cũ) khi SessionType còn NULL (dữ liệu xếp từ trước khi có
// cột này). ĐỘ DÀI phút/tiết thì vẫn luôn tính theo RoomType thật của phòng (1 tiết tại phòng Lý
// thuyết luôn là 45 phút bất kể buổi đó phục vụ mục đích Lý thuyết hay Thực hành) — SessionType chỉ
// quyết định buổi cộng vào chỉ tiêu nào, không đổi độ dài vật lý của 1 tiết trong phòng đó.
// Việc BB: các dòng Schedule cùng GroupBatchId (tách nhóm học song song/xoay vòng trong 1 lần
// groupedCreate) thực chất chỉ là 1 buổi học của lớp, không phải nhiều buổi lặp lại — CHỈ 1 dòng
// đại diện (ScheduleId nhỏ nhất trong lô, RepScheduleId) được dùng để cộng vào tiến độ. Các dòng còn
// lại cùng lô KHÔNG cộng thêm lần nữa, nhưng vẫn được trả về (với category/periodsThisSession/
// cumulative* giống hệt dòng đại diện) để mọi thẻ buổi học trên lịch — kể cả các nhóm không phải đại
// diện — đều hiện đúng cùng 1 tiến độ, thay vì chỉ nhóm đầu tiên hiện còn các nhóm khác trống trơn.
// COALESCE(GroupBatchId, ScheduleId) khiến các dòng KHÔNG tách nhóm (GroupBatchId NULL) tự thành 1
// lô riêng của chính nó nên vẫn được tính bình thường, không bị ảnh hưởng.
export async function getPeriodTimelineForSubject(classId: number, subjectId: number): Promise<PeriodTimelineEntry[]> {
  const pool = await getPool();
  const rowsResult = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("subjectId", sql.Int, subjectId)
    .query<{ ScheduleId: number; RepScheduleId: number; RoomType: string; SessionType: string | null; StartTime: string; EndTime: string }>(`
      SELECT s.ScheduleId, r.RoomType, s.SessionType,
             CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime,
             s.ScheduleDate,
             MIN(s.ScheduleId) OVER (PARTITION BY COALESCE(s.GroupBatchId, s.ScheduleId)) AS RepScheduleId
      FROM Schedule s
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      WHERE s.ClassId = @classId AND s.SubjectId = @subjectId
      ORDER BY s.ScheduleDate, s.StartTime, s.ScheduleId
    `);

  const periodMinutesCache = new Map<string, number>();

  // Bước 1: chỉ cộng dồn qua các dòng ĐẠI DIỆN (1 dòng/lô), theo đúng thứ tự thời gian CỦA CHÍNH
  // các dòng đại diện đó — không dùng thứ tự xen kẽ với các dòng không-đại-diện trong cùng lô (1
  // nhóm có ScheduleId nhỏ nhất chưa chắc có Ngày sớm nhất, vì Việc AY cho mỗi nhóm tự chọn Ngày/Ca
  // riêng độc lập với thứ tự tạo).
  let cumulativeTheory = 0;
  let cumulativePractice = 0;
  const batchResults = new Map<number, Omit<PeriodTimelineEntry, "scheduleId">>();
  for (const row of rowsResult.recordset) {
    if (row.ScheduleId !== row.RepScheduleId) continue;
    const category: SessionCategory | null =
      row.SessionType === "Theory" ? "LyThuyet"
      : row.SessionType === "Practice" ? "ThucHanh"
      : classifyRoomCategory(row.RoomType);

    let periodMinutes = periodMinutesCache.get(row.RoomType);
    if (periodMinutes === undefined) {
      periodMinutes = await getPeriodMinutes(row.RoomType);
      periodMinutesCache.set(row.RoomType, periodMinutes);
    }
    const periods = diffMinutes(row.StartTime, row.EndTime) / periodMinutes;
    if (category === "LyThuyet") cumulativeTheory += periods;
    else if (category === "ThucHanh") cumulativePractice += periods;
    batchResults.set(row.RepScheduleId, {
      category,
      periodsThisSession: Math.round(periods * 10) / 10,
      cumulativeTheoryPeriods: Math.round(cumulativeTheory * 10) / 10,
      cumulativePracticePeriods: Math.round(cumulativePractice * 10) / 10,
    });
  }

  // Bước 2: mọi dòng gốc (kể cả dòng không-đại-diện) đều được trả về, dùng CHUNG kết quả của lô —
  // để mọi thẻ buổi học trên lịch, kể cả các nhóm không phải đại diện, hiện đúng cùng 1 tiến độ.
  const timeline: PeriodTimelineEntry[] = rowsResult.recordset.map((row) => ({
    scheduleId: row.ScheduleId,
    ...batchResults.get(row.RepScheduleId)!,
  }));
  return timeline;
}

// Việc BE: Thứ 2 (đầu tuần) chứa 1 ngày bất kỳ — tính bằng UTC để tránh lệch múi giờ server, cùng
// quy ước "Thứ 2 đầu tuần" đã dùng ở frontend (utils/calendar.ts's startOfWeek: day===0 ? -6 : 1-day).
// Export để autoScheduler.ts (xếp theo TUẦN) tái sử dụng đúng mốc tuần, không định nghĩa lại.
export function mondayOfWeekContaining(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay(); // 0=CN, 1=T2, ... 6=T7
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface SemesterWeek {
  weekNumber: number;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

// CÙNG thuật toán với frontend/utils/calendar.ts's getWeeksInSemester (Tuần 1 = Thứ 2 của tuần chứa
// startDate, các tuần sau +7 ngày, đến khi vượt qua endDate) — bản backend dùng chuỗi ngày UTC, để
// autoScheduler.ts (xếp theo TUẦN) đánh số Tuần 1..N khớp đúng với dropdown Tuần đang hiện ở frontend.
export function getWeeksInSemester(startDate: string, endDate: string): SemesterWeek[] {
  const weeks: SemesterWeek[] = [];
  let cursor = mondayOfWeekContaining(startDate);
  let weekNumber = 1;
  while (cursor <= endDate) {
    weeks.push({ weekNumber, start: cursor, end: addDaysToDateStr(cursor, 6) });
    cursor = addDaysToDateStr(cursor, 7);
    weekNumber++;
  }
  return weeks;
}

interface TeacherWeeklyHoursCheckParams {
  teacherId: number;
  scheduleDate: string;
  roomId: number;
  startTime: string;
  endTime: string;
  excludeScheduleId?: number | null;
  excludeMergedSessionId?: number | null;
}
interface TeacherWeeklyHoursCheckResult {
  violated: boolean;
  currentHours: number;
  maxHours: number;
  message?: string;
}

// Việc BE: chặn cứng nếu tổng "giờ dạy chuẩn" của 1 GV trong TUẦN (Thứ 2-CN) chứa scheduleDate vượt
// MaxTeachingHoursPerWeek — khác với định mức/NĂM (đã có ở reportController.teachingHours), mục
// đích tránh GV bị dồn quá tải 1 tuần cụ thể dù tổng năm vẫn còn dư định mức. "Giờ dạy chuẩn" quy
// đổi phút thực theo TheoryPeriodMinutes/PracticePeriodMinutes — CÙNG quy ước đơn vị với
// MaxTeachingHoursPerYear (reportController.teachingHours), không phải giờ đồng hồ thô, để nhất
// quán trong cùng họ policy "MaxTeachingHours*".
// Ghép lớp (MergedSessionId khác NULL) tạo nhiều dòng Schedule (1 dòng/lớp) cho CÙNG 1 buổi dạy
// thật của GV — chỉ tính 1 lần/MergedSessionId, tránh nhân đôi/ba giờ dạy của 1 buổi ghép nhiều lớp.
// KHÔNG áp dụng dedup tương tự cho Tách nhóm (GroupBatchId, Việc BB): các nhóm tách ra thường học ở
// THỜI ĐIỂM KHÁC NHAU (xoay vòng dùng chung phòng) nên với GV đó vẫn là giờ dạy thật riêng biệt,
// khác bản chất với Ghép lớp (luôn CÙNG giờ, chỉ khác lớp tham gia).
export async function checkTeacherWeeklyHours({
  teacherId, scheduleDate, roomId, startTime, endTime,
  excludeScheduleId = null, excludeMergedSessionId = null,
}: TeacherWeeklyHoursCheckParams): Promise<TeacherWeeklyHoursCheckResult> {
  const maxHours = await getPolicyValue("MaxTeachingHoursPerWeek");
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false, currentHours: 0, maxHours };

  const weekStart = mondayOfWeekContaining(scheduleDate);
  const weekEndDate = new Date(`${weekStart}T00:00:00Z`);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);

  const pool = await getPool();
  const existingResult = await pool
    .request()
    .input("teacherId", sql.Int, teacherId)
    .input("weekStart", sql.Date, weekStart)
    .input("weekEnd", sql.Date, weekEnd)
    .input("excludeId", sql.Int, excludeScheduleId)
    .input("excludeMergedId", sql.Int, excludeMergedSessionId)
    .query<{ ScheduleId: number; MergedSessionId: number | null; RoomType: string; StartTime: string; EndTime: string }>(`
      SELECT s.ScheduleId, s.MergedSessionId, r.RoomType,
             CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
      FROM Schedule s
      INNER JOIN ScheduleTeachers st ON st.ScheduleId = s.ScheduleId
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      WHERE st.TeacherId = @teacherId AND s.ScheduleDate BETWEEN @weekStart AND @weekEnd
        AND (@excludeId IS NULL OR s.ScheduleId <> @excludeId)
        AND (@excludeMergedId IS NULL OR s.MergedSessionId IS NULL OR s.MergedSessionId <> @excludeMergedId)
    `);

  const seenMergedSessions = new Set<number>();
  let currentHours = 0;
  for (const row of existingResult.recordset) {
    if (row.MergedSessionId != null) {
      if (seenMergedSessions.has(row.MergedSessionId)) continue;
      seenMergedSessions.add(row.MergedSessionId);
    }
    const periodMinutes = await getPeriodMinutes(row.RoomType);
    currentHours += diffMinutes(row.StartTime, row.EndTime) / periodMinutes;
  }

  const addedPeriodMinutes = await getPeriodMinutes(room.RoomType);
  const addedHours = diffMinutes(startTime, endTime) / addedPeriodMinutes;
  const totalHours = currentHours + addedHours;

  if (totalHours > maxHours) {
    const teacherResult = await pool
      .request()
      .input("teacherId", sql.Int, teacherId)
      .query<{ FullName: string }>(`SELECT FullName FROM Teachers WHERE TeacherId = @teacherId`);
    const teacherName = teacherResult.recordset[0]?.FullName ?? `GV #${teacherId}`;
    return {
      violated: true,
      currentHours: Math.round(currentHours * 10) / 10,
      maxHours,
      message: `GV ${teacherName} đã dạy ${Math.round(currentHours * 10) / 10}/${maxHours} giờ trong tuần này, tiết này cần thêm ${Math.round(addedHours * 10) / 10} giờ — vượt định mức giờ dạy/tuần`,
    };
  }
  return { violated: false, currentHours: Math.round(currentHours * 10) / 10, maxHours };
}

interface TeacherYearlyHoursCheckParams {
  teacherId: number;
  scheduleDate: string;
  roomId: number;
  startTime: string;
  endTime: string;
  excludeScheduleId?: number | null;
  excludeMergedSessionId?: number | null;
}
interface TeacherYearlyHoursCheckResult {
  violated: boolean;
  currentHours: number;
  maxHours: number;
  message?: string;
}

// Việc BF: CÙNG PATTERN hệt checkTeacherWeeklyHours ở trên (dedup MergedSessionId, KHÔNG dedup
// GroupBatchId, "giờ dạy chuẩn" quy đổi tiết theo TheoryPeriodMinutes/PracticePeriodMinutes) — chỉ
// khác PHẠM VI tính: NĂM DƯƠNG LỊCH chứa scheduleDate thay vì tuần, và định mức lấy theo CHỨC VỤ của
// GV (Trưởng/Phó khoa dùng MaxTeachingHoursPerYearManager, còn lại MaxTeachingHoursPerYearStandard —
// cùng cách xác định isManager đã dùng ở reportController.teachingHours). Mục đích: đảm bảo tổng cả
// năm không vượt định mức dù từng tuần vẫn còn dư (checkTeacherWeeklyHours không bắt được trường hợp
// này vì chỉ xét riêng từng tuần).
export async function checkTeacherYearlyHours({
  teacherId, scheduleDate, roomId, startTime, endTime,
  excludeScheduleId = null, excludeMergedSessionId = null,
}: TeacherYearlyHoursCheckParams): Promise<TeacherYearlyHoursCheckResult> {
  const pool = await getPool();
  const teacherResult = await pool
    .request()
    .input("teacherId", sql.Int, teacherId)
    .query<{ FullName: string; PositionName: string | null }>(`
      SELECT t.FullName, p.PositionName
      FROM Teachers t
      LEFT JOIN Positions p ON p.PositionId = t.PositionId
      WHERE t.TeacherId = @teacherId
    `);
  const teacherRow = teacherResult.recordset[0];
  const teacherName = teacherRow?.FullName ?? `GV #${teacherId}`;
  const isManager = teacherRow?.PositionName != null
    && (teacherRow.PositionName.includes("Trưởng khoa") || teacherRow.PositionName.includes("Phó"));
  const maxHours = await getPolicyValue(isManager ? "MaxTeachingHoursPerYearManager" : "MaxTeachingHoursPerYearStandard");

  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false, currentHours: 0, maxHours };

  const year = Number(scheduleDate.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const existingResult = await pool
    .request()
    .input("teacherId", sql.Int, teacherId)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd)
    .input("excludeId", sql.Int, excludeScheduleId)
    .input("excludeMergedId", sql.Int, excludeMergedSessionId)
    .query<{ ScheduleId: number; MergedSessionId: number | null; RoomType: string; StartTime: string; EndTime: string }>(`
      SELECT s.ScheduleId, s.MergedSessionId, r.RoomType,
             CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime, CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
      FROM Schedule s
      INNER JOIN ScheduleTeachers st ON st.ScheduleId = s.ScheduleId
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      WHERE st.TeacherId = @teacherId AND s.ScheduleDate BETWEEN @yearStart AND @yearEnd
        AND (@excludeId IS NULL OR s.ScheduleId <> @excludeId)
        AND (@excludeMergedId IS NULL OR s.MergedSessionId IS NULL OR s.MergedSessionId <> @excludeMergedId)
    `);

  const seenMergedSessions = new Set<number>();
  let currentHours = 0;
  for (const row of existingResult.recordset) {
    if (row.MergedSessionId != null) {
      if (seenMergedSessions.has(row.MergedSessionId)) continue;
      seenMergedSessions.add(row.MergedSessionId);
    }
    const periodMinutes = await getPeriodMinutes(row.RoomType);
    currentHours += diffMinutes(row.StartTime, row.EndTime) / periodMinutes;
  }

  const addedPeriodMinutes = await getPeriodMinutes(room.RoomType);
  const addedHours = diffMinutes(startTime, endTime) / addedPeriodMinutes;
  const totalHours = currentHours + addedHours;

  if (totalHours > maxHours) {
    return {
      violated: true,
      currentHours: Math.round(currentHours * 10) / 10,
      maxHours,
      message: `GV ${teacherName} đã dạy ${Math.round(currentHours * 10) / 10}/${maxHours} giờ trong năm ${year}, tiết này cần thêm ${Math.round(addedHours * 10) / 10} giờ — vượt định mức giờ dạy/năm`,
    };
  }
  return { violated: false, currentHours: Math.round(currentHours * 10) / 10, maxHours };
}
