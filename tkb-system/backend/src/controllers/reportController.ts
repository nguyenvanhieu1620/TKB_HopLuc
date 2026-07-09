import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest } from "../types";
import { getPolicyValues } from "../utils/policyConfig";
import { classifyRoomCategory, diffMinutes } from "../utils/policyRules";

interface ScheduleHoursRow {
  TeacherId: number;
  RoomType: string;
  StartTime: string;
  EndTime: string;
}

// Việc X: tổng giờ dạy chuẩn/năm của mỗi GV, quy đổi phút thực theo TheoryPeriodMinutes /
// PracticePeriodMinutes (cùng cách quy đổi buổi/giờ đã dùng ở policyRules.ts), so với định mức
// theo chức vụ (Trưởng/Phó khoa dùng định mức quản lý, còn lại dùng định mức chuẩn).
export async function teachingHours(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();

    const policies = await getPolicyValues([
      "TheoryPeriodMinutes",
      "PracticePeriodMinutes",
      "MaxTeachingHoursPerYearManager",
      "MaxTeachingHoursPerYearStandard",
    ]);

    const pool = await getPool();
    const scheduleResult = await pool
      .request()
      .input("year", sql.Int, year)
      .query<ScheduleHoursRow>(`
        SELECT st.TeacherId, r.RoomType,
               CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime,
               CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
        FROM Schedule s
        INNER JOIN ScheduleTeachers st ON st.ScheduleId = s.ScheduleId
        INNER JOIN Rooms r ON r.RoomId = s.RoomId
        WHERE YEAR(s.ScheduleDate) = @year
      `);

    const hoursByTeacher = new Map<number, number>();
    for (const row of scheduleResult.recordset) {
      const category = classifyRoomCategory(row.RoomType);
      if (!category) continue;
      const periodMinutes = category === "LyThuyet" ? policies.TheoryPeriodMinutes : policies.PracticePeriodMinutes;
      const hours = diffMinutes(row.StartTime, row.EndTime) / periodMinutes;
      hoursByTeacher.set(row.TeacherId, (hoursByTeacher.get(row.TeacherId) || 0) + hours);
    }

    const teacherResult = await pool.request().query<{
      TeacherId: number;
      FullName: string;
      PositionName: string | null;
    }>(`
      SELECT t.TeacherId, t.FullName, p.PositionName
      FROM Teachers t
      LEFT JOIN Positions p ON p.PositionId = t.PositionId
      WHERE t.IsActive = 1
      ORDER BY t.FullName
    `);

    const report = teacherResult.recordset.map((t) => {
      const isManager = t.PositionName != null
        && (t.PositionName.includes("Trưởng khoa") || t.PositionName.includes("Phó"));
      const maxHours = isManager ? policies.MaxTeachingHoursPerYearManager : policies.MaxTeachingHoursPerYearStandard;
      const totalHours = Math.round((hoursByTeacher.get(t.TeacherId) || 0) * 10) / 10;
      const percentUsed = maxHours > 0 ? Math.round((totalHours / maxHours) * 1000) / 10 : 0;
      return {
        teacherId: t.TeacherId,
        fullName: t.FullName,
        totalHours,
        maxHours,
        percentUsed,
        isOverLimit: totalHours > maxHours,
      };
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
}
