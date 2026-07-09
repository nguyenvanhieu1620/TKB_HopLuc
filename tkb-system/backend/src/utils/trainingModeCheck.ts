import { sql, getPool } from "../config/db";

type TrainingMode = "CQ" | "LT";
type Period = "Sang" | "Chieu" | "Toi";

// Xác định buổi (Sáng/Chiều/Tối) theo giờ bắt đầu — độc lập với tên Ca học tự đặt
// (Ca học là danh mục tự do, có thể đổi tên/thêm mới) nên dùng mốc giờ cố định
// để phân loại đúng buổi theo quy chuẩn nghiệp vụ, không phụ thuộc cách đặt tên.
function classifyPeriod(startTime: string): Period {
  const hour = Number(startTime.split(":")[0]);
  if (hour < 12) return "Sang";
  if (hour < 18) return "Chieu";
  return "Toi";
}

// 0=CN,1=T2,...,6=T7 — tính theo UTC để tránh lệch múi giờ của server.
function getWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

interface TrainingModeCheckParams {
  classId: number;
  scheduleDate: string;
  startTime: string;
  isMakeup?: boolean;
  excludeScheduleId?: number | null;
  excludeMergedSessionId?: number | null;
}

interface TrainingModeCheckResult {
  violated: boolean;
  message?: string;
  trainingMode?: TrainingMode | null;
}

export async function getClassTrainingMode(classId: number): Promise<{ trainingMode: TrainingMode | null; className: string } | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .query<{ TrainingMode: TrainingMode | null; ClassName: string }>(`
      SELECT m.TrainingMode, c.ClassName
      FROM Classes c INNER JOIN Majors m ON m.MajorId = c.MajorId
      WHERE c.ClassId = @classId
    `);
  const row = result.recordset[0];
  if (!row) return null;
  return { trainingMode: row.TrainingMode, className: row.ClassName };
}

// Ràng buộc ngày/buổi theo hệ đào tạo:
// - CQ: chỉ Thứ 2-6, và trong CÙNG 1 ngày chỉ được 1 buổi (Sáng HOẶC Chiều, không cả 2, không Tối).
//   Các ngày khác nhau trong tuần được phép khác buổi nhau — chỉ so trong phạm vi 1 ngày cụ thể.
// - LT: chỉ Thứ 7/CN (buổi nào cũng được), hoặc buổi Tối các ngày Thứ 2-6.
// Vi phạm chỉ CẢNH BÁO (không chặn cứng) trừ khi isMakeup=true (lịch học bù) thì bỏ qua hẳn.
export async function checkTrainingModeRule({
  classId,
  scheduleDate,
  startTime,
  isMakeup = false,
  excludeScheduleId = null,
  excludeMergedSessionId = null,
}: TrainingModeCheckParams): Promise<TrainingModeCheckResult> {
  const classInfo = await getClassTrainingMode(classId);
  if (!classInfo || !classInfo.trainingMode) {
    return { violated: false, trainingMode: null };
  }
  const { trainingMode, className } = classInfo;

  if (isMakeup) {
    return { violated: false, trainingMode };
  }

  const weekday = getWeekday(scheduleDate);
  const isWeekend = weekday === 0 || weekday === 6;
  const period = classifyPeriod(startTime);

  if (trainingMode === "CQ") {
    if (isWeekend) {
      return {
        violated: true, trainingMode,
        message: `Lớp ${className} thuộc hệ Chính quy — không xếp lịch vào Thứ 7/Chủ nhật`,
      };
    }
    if (period === "Toi") {
      return {
        violated: true, trainingMode,
        message: `Lớp ${className} thuộc hệ Chính quy — không xếp lịch vào buổi Tối`,
      };
    }

    const pool = await getPool();
    const sameDayResult = await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("date", sql.Date, scheduleDate)
      .input("excludeId", sql.Int, excludeScheduleId)
      .input("excludeMergedId", sql.Int, excludeMergedSessionId)
      .query<{ StartTime: string }>(`
        SELECT CONVERT(VARCHAR(5), StartTime, 108) AS StartTime
        FROM Schedule
        WHERE ClassId = @classId AND ScheduleDate = @date
          AND (@excludeId IS NULL OR ScheduleId <> @excludeId)
          AND (@excludeMergedId IS NULL OR MergedSessionId IS NULL OR MergedSessionId <> @excludeMergedId)
      `);
    const hasOtherPeriod = sameDayResult.recordset.some((r) => classifyPeriod(r.StartTime) !== period);
    if (hasOtherPeriod) {
      return {
        violated: true, trainingMode,
        message: `Lớp ${className} đã có buổi khác trong ngày ${scheduleDate} (hệ Chính quy chỉ học 1 buổi/ngày)`,
      };
    }
    return { violated: false, trainingMode };
  }

  // LT
  if (!isWeekend && period !== "Toi") {
    return {
      violated: true, trainingMode,
      message: `Lớp ${className} thuộc hệ Liên thông — Thứ 2-6 chỉ xếp lịch vào buổi Tối`,
    };
  }
  return { violated: false, trainingMode };
}
