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

export function classifyRoomCategory(roomType: string): SessionCategory | null {
  if (roomType === "LyThuyet") return "LyThuyet";
  if (roomType === "ThucHanh" || roomType === "LamSang") return "ThucHanh";
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

// Việc S (1/2): 1 buổi không nên dài quá MaxTheoryHoursPerSession / MaxPracticeHoursPerSession — CẢNH BÁO.
export async function checkSessionLength({ roomId, startTime, endTime }: SessionLengthCheckParams): Promise<SessionLengthCheckResult> {
  const room = await getRoomInfo(roomId);
  if (!room) return { violated: false };
  const category = classifyRoomCategory(room.RoomType);
  if (!category) return { violated: false };

  const minutes = diffMinutes(startTime, endTime);
  const maxHoursKey = category === "LyThuyet" ? "MaxTheoryHoursPerSession" : "MaxPracticeHoursPerSession";
  const maxHours = await getPolicyValue(maxHoursKey);

  if (minutes > maxHours * 60) {
    return {
      violated: true,
      message: `Buổi ${categoryLabel(category)} dài ${(minutes / 60).toFixed(1)} giờ, vượt giới hạn ${maxHours} giờ/buổi`,
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

// Việc S (2/2): tổng giờ Lý thuyết/Thực hành của 1 Lớp trong 1 NGÀY không quá MaxTheoryHoursPerDay /
// MaxPracticeHoursPerDay (tính cả các Schedule khác đã có cùng lớp, cùng ngày, cùng loại phòng) — CẢNH BÁO.
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

  const roomTypesInCategory = category === "LyThuyet" ? ["LyThuyet"] : ["ThucHanh", "LamSang"];
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

  const existingMinutes = existingResult.recordset.reduce((sum, r) => sum + diffMinutes(r.StartTime, r.EndTime), 0);
  const totalMinutes = existingMinutes + diffMinutes(startTime, endTime);

  const maxHoursKey = category === "LyThuyet" ? "MaxTheoryHoursPerDay" : "MaxPracticeHoursPerDay";
  const maxHours = await getPolicyValue(maxHoursKey);

  if (totalMinutes > maxHours * 60) {
    return {
      violated: true,
      message: `Tổng giờ ${categoryLabel(category)} ngày ${scheduleDate} của lớp là ${(totalMinutes / 60).toFixed(1)} giờ, vượt giới hạn ${maxHours} giờ/ngày`,
    };
  }
  return { violated: false };
}
