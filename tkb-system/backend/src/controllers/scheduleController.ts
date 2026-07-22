import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { checkScheduleConflict, findHoliday, checkExamPeriodWarning } from "../utils/conflictCheck";
import { checkTrainingModeRule, getClassTrainingMode, getClassMajorTrainingMode } from "../utils/trainingModeCheck";
import { checkRoomCapacity, checkSessionLength, checkDailyHoursLimit, checkTeacherWeeklyHours, checkTeacherYearlyHours, getClassSize, getTotalPeriodsForSubject, getPeriodTimelineForSubject, getRoomInfo, getRequiredGroupCount, getSubjectRequiresGrouping, checkSubjectRoom } from "../utils/policyRules";
import { writeAuditLog } from "../utils/auditLog";
import { notifyTeachers } from "../utils/notify";
import { AuthRequest } from "../types";

async function getClassSubjectNames(classId: number, subjectId: number): Promise<{ className: string; subjectName: string } | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("classId", sql.Int, classId)
    .input("subjectId", sql.Int, subjectId)
    .query<{ ClassName: string; SubjectName: string }>(`
      SELECT (SELECT ClassName FROM Classes WHERE ClassId = @classId) AS ClassName,
             (SELECT SubjectName FROM Subjects WHERE SubjectId = @subjectId) AS SubjectName
    `);
  const row = result.recordset[0];
  if (!row || !row.ClassName || !row.SubjectName) return null;
  return { className: row.ClassName, subjectName: row.SubjectName };
}

// Việc BH: tham số đúng cho checkRoomCapacity của 1 dòng Schedule — dòng ĐÃ tách nhóm (groupLabel
// khác NULL) phải so sức chứa THẬT của phòng với sĩ số RIÊNG của nhóm đó (Math.ceil(sĩ số cả lớp /
// số nhóm theo bảng mốc getRequiredGroupCount) — không phải cả lớp; dòng học chung cả lớp
// (groupLabel NULL, vd Lý thuyết) giữ nguyên so với mốc chính sách như trước, không đổi gì.
// Việc BT: dòng học chung cả lớp (groupLabel NULL) ở phòng Thực hành/Lâm sàng NHƯNG môn không cần
// chia nhóm (Subjects.RequiresGrouping = 0) — cũng so với sức chứa THẬT của phòng (như dòng đã tách
// nhóm) thay vì mốc chính sách MaxStudentsPerPracticeGroup/MaxStudentsPerClinicalGroup, vì thực chất
// không có nhóm nào cả (cả lớp học chung ở phòng đủ rộng, vd sân bãi Giáo dục thể chất).
async function capacityCheckParamsFor(
  roomId: number, classSize: number, groupLabel: string | null, subjectId?: number
): Promise<{ roomId: number; totalStudents: number; isGroupSplit: boolean }> {
  const room = await getRoomInfo(roomId);
  if (groupLabel) {
    const sessionTypeBracket = room?.RoomType === "LamSang" ? "Clinical" : "Practice";
    const totalStudents = Math.ceil(classSize / getRequiredGroupCount(classSize, sessionTypeBracket));
    return { roomId, totalStudents, isGroupSplit: true };
  }
  const isPracticeRoom = room?.RoomType === "ThucHanh" || room?.RoomType === "Labo" || room?.RoomType === "LamSang";
  if (isPracticeRoom && subjectId) {
    const requiresGrouping = await getSubjectRequiresGrouping(subjectId);
    if (!requiresGrouping) return { roomId, totalStudents: classSize, isGroupSplit: true };
  }
  return { roomId, totalStudents: classSize, isGroupSplit: false };
}

function conflictMessage(conflict: { roomUnavailable: unknown[]; teacherUnavailable: unknown[] }): string {
  if (conflict.roomUnavailable.length > 0) {
    return "Phòng đang tạm khóa/bảo trì trong ngày này, không thể xếp lịch";
  }
  if (conflict.teacherUnavailable.length > 0) {
    return "Giảng viên đã báo bận trong ngày này, không thể xếp lịch dạy";
  }
  return "Phát hiện xung đột lịch học (trùng phòng hoặc trùng giảng viên)";
}

interface ScheduleBody {
  semesterId?: number;
  classId?: number;
  subjectId?: number;
  roomId?: number;
  teacherIds?: number[];
  scheduleDate?: string;
  startTime?: string;
  endTime?: string;
  note?: string;
  isMakeup?: boolean;
  sessionType?: string;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId, classId, cohortId, teacherId, roomId, from, to } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();

    let where = "WHERE 1=1";
    if (semesterId) { request.input("semesterId", sql.Int, semesterId); where += " AND s.SemesterId=@semesterId"; }
    if (classId) { request.input("classId", sql.Int, classId); where += " AND s.ClassId=@classId"; }
    // Việc AU: chế độ xem "Tất cả các lớp" cần lấy lịch của NHIỀU lớp cùng khóa trong 1 lần gọi
    // (thay vì gọi riêng từng lớp) — lọc qua Classes.CohortId (đã JOIN sẵn c bên dưới).
    if (cohortId) { request.input("cohortId", sql.Int, cohortId); where += " AND c.CohortId=@cohortId"; }
    if (roomId) { request.input("roomId", sql.Int, roomId); where += " AND s.RoomId=@roomId"; }
    if (from) { request.input("from", sql.Date, from); where += " AND s.ScheduleDate>=@from"; }
    if (to) { request.input("to", sql.Date, to); where += " AND s.ScheduleDate<=@to"; }
    if (teacherId) {
      request.input("teacherId", sql.Int, teacherId);
      where += " AND EXISTS (SELECT 1 FROM ScheduleTeachers st WHERE st.ScheduleId=s.ScheduleId AND st.TeacherId=@teacherId)";
    }

    const result = await request.query(`
      SELECT s.ScheduleId, s.SemesterId, s.ClassId, c.ClassName, s.SubjectId, sub.SubjectName,
             s.RoomId, r.RoomName, s.ScheduleDate,
             CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime,
             CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime,
             s.Note, s.MergedSessionId, s.GroupLabel,
             (SELECT STRING_AGG(t.FullName, ' / ') FROM ScheduleTeachers st
                INNER JOIN Teachers t ON t.TeacherId = st.TeacherId
                WHERE st.ScheduleId = s.ScheduleId) AS Teachers
      FROM Schedule s
      INNER JOIN Classes c ON c.ClassId = s.ClassId
      INNER JOIN Subjects sub ON sub.SubjectId = s.SubjectId
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      ${where}
      ORDER BY s.ScheduleDate, s.StartTime
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

interface ClassPeriodProgressEntry {
  scheduleId: number;
  category: string | null;
  periodsThisSession: number;
  cumulativeTheoryPeriods: number;
  cumulativePracticePeriods: number;
  subjectId: number;
  theoryTarget: number;
  practiceTarget: number;
}

async function getPeriodProgressForClass(classId: number, majorId: number, cohortId: number | null): Promise<ClassPeriodProgressEntry[]> {
  const pool = await getPool();
  const subjectsResult = await pool.request().input("classId", sql.Int, classId).query<{ SubjectId: number; TermNumber: number | null }>(`
    SELECT s.SubjectId, MAX(sem.TermNumber) AS TermNumber
    FROM Schedule s
    LEFT JOIN Semesters sem ON sem.SemesterId = s.SemesterId
    WHERE s.ClassId = @classId
    GROUP BY s.SubjectId
  `);

  return (
    await Promise.all(
      subjectsResult.recordset.map(async (row) => {
        const [targets, timeline] = await Promise.all([
          getTotalPeriodsForSubject(majorId, row.SubjectId, cohortId, row.TermNumber),
          getPeriodTimelineForSubject(classId, row.SubjectId),
        ]);
        return timeline.map((entry) => ({
          ...entry, subjectId: row.SubjectId, theoryTarget: targets.theoryTarget, practiceTarget: targets.practiceTarget,
        }));
      })
    )
  ).flat();
}

// Việc AU (fix): tiến độ số tiết cho MỌI buổi đang có lịch của 1 Lớp (hoặc cả 1 Khóa, dùng cho chế
// độ xem "Tất cả các lớp") — LŨY KẾ RIÊNG theo từng buổi (không dùng chung 1 tổng cho mọi buổi
// cùng môn như bản trước, vì gây lỗi thêm buổi 2 làm số hiện trên buổi 1 cũng nhảy theo).
export async function periodProgressByClass(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, cohortId } = req.query as Record<string, string | undefined>;
    if (!classId && !cohortId) {
      res.status(400).json({ message: "Thiếu classId hoặc cohortId" });
      return;
    }
    const pool = await getPool();

    if (classId) {
      const classResult = await pool.request().input("classId", sql.Int, classId).query<{ MajorId: number; CohortId: number | null }>(
        `SELECT MajorId, CohortId FROM Classes WHERE ClassId = @classId`
      );
      const classInfo = classResult.recordset[0];
      if (!classInfo) {
        res.status(404).json({ message: "Không tìm thấy lớp" });
        return;
      }
      const progress = await getPeriodProgressForClass(Number(classId), classInfo.MajorId, classInfo.CohortId);
      res.json(progress);
      return;
    }

    const classesResult = await pool.request().input("cohortId", sql.Int, cohortId).query<{ ClassId: number; MajorId: number; CohortId: number | null }>(
      `SELECT ClassId, MajorId, CohortId FROM Classes WHERE CohortId = @cohortId AND IsActive = 1`
    );
    const progress = (
      await Promise.all(
        classesResult.recordset.map((c) => getPeriodProgressForClass(c.ClassId, c.MajorId, c.CohortId))
      )
    ).flat();
    res.json(progress);
  } catch (err) {
    next(err);
  }
}

// Việc AU: chi tiết 1 buổi học để phục vụ form Sửa — kèm danh sách GiangVienId (list chỉ trả tên
// gộp thành chuỗi, không đủ để prefill multi-select) và tiến độ số tiết đã xếp/tổng số tiết môn.
export async function getById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query<{
      ScheduleId: number; ClassId: number; ClassName: string; MajorId: number; CohortId: number | null;
      SubjectId: number; SubjectName: string; RoomId: number; RoomName: string; RoomType: string;
      ScheduleDate: string; StartTime: string; EndTime: string; Note: string | null;
      MergedSessionId: number | null; GroupLabel: string | null; TermNumber: number | null;
      SessionType: string | null;
    }>(`
      SELECT s.ScheduleId, s.ClassId, c.ClassName, c.MajorId, c.CohortId,
             s.SubjectId, sub.SubjectName, s.RoomId, r.RoomName, r.RoomType,
             CONVERT(VARCHAR(10), s.ScheduleDate, 23) AS ScheduleDate,
             CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime,
             CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime,
             s.Note, s.MergedSessionId, s.GroupLabel, sem.TermNumber, s.SessionType
      FROM Schedule s
      INNER JOIN Classes c ON c.ClassId = s.ClassId
      INNER JOIN Subjects sub ON sub.SubjectId = s.SubjectId
      INNER JOIN Rooms r ON r.RoomId = s.RoomId
      LEFT JOIN Semesters sem ON sem.SemesterId = s.SemesterId
      WHERE s.ScheduleId = @id
    `);
    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ message: "Không tìm thấy buổi học" });
      return;
    }

    const teacherResult = await pool.request().input("id", sql.Int, id).query<{ TeacherId: number }>(
      `SELECT TeacherId FROM ScheduleTeachers WHERE ScheduleId = @id`
    );
    const teacherIds = teacherResult.recordset.map((t) => t.TeacherId);

    const [targets, timeline] = await Promise.all([
      getTotalPeriodsForSubject(row.MajorId, row.SubjectId, row.CohortId, row.TermNumber),
      getPeriodTimelineForSubject(row.ClassId, row.SubjectId),
    ]);
    const thisEntry = timeline.find((t) => t.scheduleId === row.ScheduleId);

    res.json({
      ...row, teacherIds,
      theoryTarget: targets.theoryTarget,
      practiceTarget: targets.practiceTarget,
      periodsThisSession: thisEntry?.periodsThisSession ?? 0,
      cumulativeTheoryPeriods: thisEntry?.cumulativeTheoryPeriods ?? 0,
      cumulativePracticePeriods: thisEntry?.cumulativePracticePeriods ?? 0,
    });
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classId, subjectId, roomId, teacherIds = [],
      scheduleDate, startTime, endTime, note, isMakeup, sessionType,
    } = req.body as ScheduleBody;

    if (!semesterId || !classId || !subjectId || !roomId || !scheduleDate || !startTime || !endTime) {
      res.status(400).json({ message: "Thiếu thông tin bắt buộc để xếp lịch" });
      return;
    }

    const conflict = await checkScheduleConflict({
      roomId, teacherIds, date: scheduleDate, startTime, endTime,
    });
    if (conflict.hasConflict) {
      res.status(409).json({ message: conflictMessage(conflict), conflict });
      return;
    }

    const classSize = await getClassSize(classId);
    const capacityCheck = await checkRoomCapacity(
      await capacityCheckParamsFor(roomId, classSize, null, subjectId)
    );
    if (capacityCheck.violated) {
      res.status(400).json({ message: capacityCheck.message });
      return;
    }

    // Việc BR: buổi Thực hành/Lâm sàng — nếu môn đã gán riêng danh sách phòng phù hợp (SubjectRooms),
    // phòng chọn PHẢI nằm trong đúng danh sách đó. Môn chưa cấu hình thì bỏ qua (không chặn thêm).
    const subjectRoomCheck = await checkSubjectRoom({ subjectId, roomId, sessionType });
    if (subjectRoomCheck.violated) {
      res.status(400).json({ message: subjectRoomCheck.message });
      return;
    }

    // Việc AX: chặn cứng (không chỉ cảnh báo) — kiểm tra TRƯỚC khi insert để không phải vừa lưu
    // vừa rollback nếu vi phạm.
    const sessionLengthCheck = await checkSessionLength({ roomId, startTime, endTime });
    if (sessionLengthCheck.violated) {
      res.status(400).json({ message: sessionLengthCheck.message });
      return;
    }
    const dailyHoursCheck = await checkDailyHoursLimit({ classId, scheduleDate, roomId, startTime, endTime });
    if (dailyHoursCheck.violated) {
      res.status(400).json({ message: dailyHoursCheck.message });
      return;
    }

    // Việc BE/BF: chặn cứng nếu BẤT KỲ giảng viên nào trong danh sách vượt định mức giờ dạy/tuần
    // hoặc/năm.
    for (const teacherId of teacherIds) {
      const weeklyHoursCheck = await checkTeacherWeeklyHours({ teacherId, scheduleDate, roomId, startTime, endTime });
      if (weeklyHoursCheck.violated) {
        res.status(400).json({ message: weeklyHoursCheck.message });
        return;
      }
      const yearlyHoursCheck = await checkTeacherYearlyHours({ teacherId, scheduleDate, roomId, startTime, endTime });
      if (yearlyHoursCheck.violated) {
        res.status(400).json({ message: yearlyHoursCheck.message });
        return;
      }
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("semesterId", sql.Int, semesterId)
      .input("classId", sql.Int, classId)
      .input("subjectId", sql.Int, subjectId)
      .input("roomId", sql.Int, roomId)
      .input("scheduleDate", sql.Date, scheduleDate)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("note", sql.NVarChar, note || null)
      .input("sessionType", sql.NVarChar, sessionType || null)
      .input("createdBy", sql.Int, req.user!.userId)
      .query<{ ScheduleId: number }>(`
        INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, SessionType, CreatedBy)
        OUTPUT INSERTED.ScheduleId
        VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @sessionType, @createdBy)
      `);
    const scheduleId = result.recordset[0].ScheduleId;

    for (const teacherId of teacherIds) {
      await pool
        .request()
        .input("scheduleId", sql.Int, scheduleId)
        .input("teacherId", sql.Int, teacherId)
        .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
    }

    await writeAuditLog({
      userId: req.user!.userId, action: "Insert", tableName: "Schedule",
      recordId: scheduleId, detail: req.body,
    });

    if (teacherIds.length > 0) {
      const names = await getClassSubjectNames(classId, subjectId);
      if (names) {
        await notifyTeachers(
          teacherIds,
          `Lịch dạy mới: Lớp ${names.className} - ${names.subjectName}, ngày ${scheduleDate} (${startTime}-${endTime})`,
          "Schedule",
          scheduleId
        );
      }
    }

    // Việc CA: Lịch nghỉ tính theo hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride) —
    // khác với checkTrainingModeRule ngay dưới đây (vẫn ưu tiên override, đúng cho ngày/buổi).
    const majorClassInfo = await getClassMajorTrainingMode(classId);
    const holiday = await findHoliday(scheduleDate, majorClassInfo?.trainingMode);
    const trainingCheck = await checkTrainingModeRule({
      classId, scheduleDate, startTime, isMakeup,
    });
    const examPeriodWarning = await checkExamPeriodWarning(semesterId, scheduleDate);

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (trainingCheck.violated) warnings.push(trainingCheck.message!);
    if (examPeriodWarning) warnings.push(examPeriodWarning);

    res.status(201).json({
      scheduleId,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const {
      classId, subjectId, roomId, teacherIds = [],
      scheduleDate, startTime, endTime, note, isMakeup, sessionType,
    } = req.body as ScheduleBody;

    const conflict = await checkScheduleConflict({
      roomId: roomId as number, teacherIds, date: scheduleDate as string,
      startTime: startTime as string, endTime: endTime as string, excludeScheduleId: Number(id),
    });
    if (conflict.hasConflict) {
      res.status(409).json({ message: conflictMessage(conflict), conflict });
      return;
    }

    const classSize = await getClassSize(classId as number);
    // Việc BH: buổi đang sửa có thể là 1 dòng ĐÃ tách nhóm (GroupLabel khác NULL, cột này không có
    // trong ScheduleBody nên không đổi được khi Sửa) — tra lại từ chính dòng đang sửa để kiểm tra sức
    // chứa đúng theo sĩ số RIÊNG của nhóm đó, không phải cả lớp.
    const existingGroupResult = await (await getPool())
      .request()
      .input("id", sql.Int, id)
      .query<{ GroupLabel: string | null }>(`SELECT GroupLabel FROM Schedule WHERE ScheduleId = @id`);
    const existingGroupLabel = existingGroupResult.recordset[0]?.GroupLabel ?? null;

    const capacityCheck = await checkRoomCapacity(
      await capacityCheckParamsFor(roomId as number, classSize, existingGroupLabel, subjectId)
    );
    if (capacityCheck.violated) {
      res.status(400).json({ message: capacityCheck.message });
      return;
    }

    // Việc AX: chặn cứng (không chỉ cảnh báo) — kiểm tra TRƯỚC khi update để không phải vừa lưu
    // vừa rollback nếu vi phạm.
    const sessionLengthCheck = await checkSessionLength({
      roomId: roomId as number, startTime: startTime as string, endTime: endTime as string,
    });
    if (sessionLengthCheck.violated) {
      res.status(400).json({ message: sessionLengthCheck.message });
      return;
    }
    const dailyHoursCheck = await checkDailyHoursLimit({
      classId: classId as number, scheduleDate: scheduleDate as string, roomId: roomId as number,
      startTime: startTime as string, endTime: endTime as string, excludeScheduleId: Number(id),
    });
    if (dailyHoursCheck.violated) {
      res.status(400).json({ message: dailyHoursCheck.message });
      return;
    }

    // Việc BE/BF: chặn cứng nếu BẤT KỲ giảng viên nào trong danh sách vượt định mức giờ dạy/tuần
    // hoặc/năm — loại trừ chính dòng đang sửa (excludeScheduleId) để không tự cộng dồn 2 lần.
    for (const teacherId of teacherIds) {
      const weeklyHoursCheck = await checkTeacherWeeklyHours({
        teacherId, scheduleDate: scheduleDate as string, roomId: roomId as number,
        startTime: startTime as string, endTime: endTime as string, excludeScheduleId: Number(id),
      });
      if (weeklyHoursCheck.violated) {
        res.status(400).json({ message: weeklyHoursCheck.message });
        return;
      }
      const yearlyHoursCheck = await checkTeacherYearlyHours({
        teacherId, scheduleDate: scheduleDate as string, roomId: roomId as number,
        startTime: startTime as string, endTime: endTime as string, excludeScheduleId: Number(id),
      });
      if (yearlyHoursCheck.violated) {
        res.status(400).json({ message: yearlyHoursCheck.message });
        return;
      }
    }

    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("classId", sql.Int, classId)
      .input("subjectId", sql.Int, subjectId)
      .input("roomId", sql.Int, roomId)
      .input("scheduleDate", sql.Date, scheduleDate)
      .input("startTime", sql.VarChar, startTime)
      .input("endTime", sql.VarChar, endTime)
      .input("note", sql.NVarChar, note || null)
      .input("sessionType", sql.NVarChar, sessionType || null)
      .query(`
        UPDATE Schedule SET ClassId=@classId, SubjectId=@subjectId, RoomId=@roomId,
          ScheduleDate=@scheduleDate, StartTime=@startTime, EndTime=@endTime,
          Note=@note, SessionType=@sessionType, UpdatedAt=SYSDATETIME()
        WHERE ScheduleId=@id
      `);

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM ScheduleTeachers WHERE ScheduleId=@id`);
    for (const teacherId of teacherIds) {
      await pool
        .request()
        .input("scheduleId", sql.Int, id)
        .input("teacherId", sql.Int, teacherId)
        .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
    }

    await writeAuditLog({
      userId: req.user!.userId, action: "Update", tableName: "Schedule",
      recordId: Number(id), detail: req.body,
    });

    if (teacherIds.length > 0) {
      const names = await getClassSubjectNames(classId as number, subjectId as number);
      if (names) {
        await notifyTeachers(
          teacherIds,
          `Lịch dạy đã thay đổi: Lớp ${names.className} - ${names.subjectName}, ngày ${scheduleDate} (${startTime}-${endTime})`,
          "Schedule",
          Number(id)
        );
      }
    }

    // Việc CA: Lịch nghỉ tính theo hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride).
    const majorClassInfo = await getClassMajorTrainingMode(classId as number);
    const holiday = await findHoliday(scheduleDate as string, majorClassInfo?.trainingMode);
    const trainingCheck = await checkTrainingModeRule({
      classId: classId as number, scheduleDate: scheduleDate as string, startTime: startTime as string,
      isMakeup, excludeScheduleId: Number(id),
    });
    // Việc BG: SemesterId không đổi được khi Sửa (không có trong ScheduleBody/form) — tra lại từ
    // chính dòng đang sửa để biết đúng Kỳ nào áp dụng cảnh báo giai đoạn thi.
    const semesterResult = await pool.request().input("id", sql.Int, id).query<{ SemesterId: number }>(
      `SELECT SemesterId FROM Schedule WHERE ScheduleId = @id`
    );
    const examPeriodWarning = await checkExamPeriodWarning(semesterResult.recordset[0]?.SemesterId, scheduleDate as string);

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (trainingCheck.violated) warnings.push(trainingCheck.message!);
    if (sessionLengthCheck.violated) warnings.push(sessionLengthCheck.message!);
    if (dailyHoursCheck.violated) warnings.push(dailyHoursCheck.message!);
    if (examPeriodWarning) warnings.push(examPeriodWarning);

    res.json({
      message: "Đã cập nhật lịch học",
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();

    // Lấy thông tin buổi học + GV liên quan TRƯỚC khi xóa, vì sau DELETE sẽ không còn truy vấn được.
    const infoResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{
        ClassName: string; SubjectName: string; ScheduleDate: string; StartTime: string; EndTime: string;
      }>(`
        SELECT c.ClassName, sub.SubjectName,
               CONVERT(VARCHAR(10), s.ScheduleDate, 23) AS ScheduleDate,
               CONVERT(VARCHAR(5), s.StartTime, 108) AS StartTime,
               CONVERT(VARCHAR(5), s.EndTime, 108) AS EndTime
        FROM Schedule s
        INNER JOIN Classes c ON c.ClassId = s.ClassId
        INNER JOIN Subjects sub ON sub.SubjectId = s.SubjectId
        WHERE s.ScheduleId = @id
      `);
    const info = infoResult.recordset[0];
    const teacherResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{ TeacherId: number }>(`SELECT TeacherId FROM ScheduleTeachers WHERE ScheduleId = @id`);
    const teacherIds = teacherResult.recordset.map((t) => t.TeacherId);

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
    await writeAuditLog({ userId: req.user!.userId, action: "Delete", tableName: "Schedule", recordId: Number(id) });

    if (info && teacherIds.length > 0) {
      await notifyTeachers(
        teacherIds,
        `Lịch dạy đã bị hủy: Lớp ${info.ClassName} - ${info.SubjectName}, ngày ${info.ScheduleDate} (${info.StartTime}-${info.EndTime})`,
        "Schedule",
        Number(id)
      );
    }

    res.json({ message: "Đã xóa tiết học" });
  } catch (err) {
    next(err);
  }
}

interface MergedScheduleBody {
  semesterId?: number;
  classIds?: number[];
  subjectId?: number;
  roomId?: number;
  teacherIds?: number[];
  scheduleDate?: string;
  startTime?: string;
  endTime?: string;
  note?: string;
  isMakeup?: boolean;
  sessionType?: string;
}

// Ghép lớp: nhiều lớp cùng học 1 buổi (chung phòng/giờ/giảng viên). Tạo 1 dòng
// MergedSessions rồi tạo N dòng Schedule (1 dòng/lớp) cùng trỏ về MergedSessionId đó.
// Các dòng cùng MergedSessionId cố tình trùng phòng/giờ nên checkScheduleConflict phải
// loại trừ chúng khi so với nhau — chỉ chặn nếu trùng với lịch KHÁC ngoài buổi ghép này.
export async function mergedCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classIds = [], subjectId, roomId, teacherIds = [],
      scheduleDate, startTime, endTime, note, isMakeup, sessionType,
    } = req.body as MergedScheduleBody;

    if (!semesterId || !Array.isArray(classIds) || classIds.length < 2 || !subjectId || !roomId
      || !scheduleDate || !startTime || !endTime) {
      res.status(400).json({ message: "Cần chọn ít nhất 2 lớp và đủ thông tin bắt buộc để ghép lớp" });
      return;
    }

    // Ghép lớp khác hệ đào tạo (1 lớp CQ + 1 lớp LT) là lỗi logic thực sự — chặn cứng, không cho ghép.
    const classTrainingInfos = await Promise.all(classIds.map((id) => getClassTrainingMode(id)));
    const distinctModes = new Set(classTrainingInfos.map((info) => info?.trainingMode ?? null));
    if (distinctModes.size > 1) {
      const summary = classTrainingInfos
        .map((info) => `${info?.className ?? "?"} (${info?.trainingMode ?? "chưa xác định hệ"})`)
        .join(", ");
      res.status(400).json({
        message: `Không thể ghép lớp: các lớp thuộc các hệ đào tạo khác nhau — ${summary}`,
      });
      return;
    }

    // Ghép lớp dùng chung 1 phòng nên sĩ số so với giới hạn phải tính TỔNG các lớp tham gia.
    const classSizes = await Promise.all(classIds.map((id) => getClassSize(id)));
    const totalStudents = classSizes.reduce((sum, size) => sum + size, 0);
    const capacityCheck = await checkRoomCapacity({ roomId, totalStudents });
    if (capacityCheck.violated) {
      res.status(400).json({ message: capacityCheck.message });
      return;
    }

    // Việc AX: chặn cứng — cùng 1 phòng/giờ cho mọi lớp ghép nên chỉ cần kiểm tra 1 lần, TRƯỚC
    // khi tạo bất kỳ bản ghi nào (chưa có gì để rollback ở bước này).
    const sessionLengthCheck = await checkSessionLength({ roomId, startTime, endTime });
    if (sessionLengthCheck.violated) {
      res.status(400).json({ message: sessionLengthCheck.message });
      return;
    }

    const pool = await getPool();

    const mergedResult = await pool
      .request()
      .input("note", sql.NVarChar, note || null)
      .input("createdBy", sql.Int, req.user!.userId)
      .query<{ MergedSessionId: number }>(`
        INSERT INTO MergedSessions (Note, CreatedBy)
        OUTPUT INSERTED.MergedSessionId
        VALUES (@note, @createdBy)
      `);
    const mergedSessionId = mergedResult.recordset[0].MergedSessionId;

    const scheduleIds: number[] = [];
    const trainingWarnings: string[] = [];
    for (const classId of classIds) {
      const conflict = await checkScheduleConflict({
        roomId, teacherIds, date: scheduleDate, startTime, endTime, excludeMergedSessionId: mergedSessionId,
      });
      if (conflict.hasConflict) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        await pool.request().input("id", sql.Int, mergedSessionId).query(`DELETE FROM MergedSessions WHERE MergedSessionId=@id`);
        res.status(409).json({
          message: `${conflictMessage(conflict)} (lớp ID ${classId})`,
          conflict,
        });
        return;
      }

      const trainingCheck = await checkTrainingModeRule({
        classId, scheduleDate, startTime, isMakeup, excludeMergedSessionId: mergedSessionId,
      });
      if (trainingCheck.violated) trainingWarnings.push(trainingCheck.message!);

      // Việc AX: chặn cứng — vi phạm thì dọn các dòng Schedule/MergedSessions đã tạo trong lần
      // ghép lớp này (nếu có) rồi từ chối, giống cách checkScheduleConflict đã xử lý ở trên.
      const dailyHoursCheck = await checkDailyHoursLimit({
        classId, scheduleDate, roomId, startTime, endTime, excludeMergedSessionId: mergedSessionId,
      });
      if (dailyHoursCheck.violated) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        await pool.request().input("id", sql.Int, mergedSessionId).query(`DELETE FROM MergedSessions WHERE MergedSessionId=@id`);
        res.status(400).json({ message: `${dailyHoursCheck.message} (lớp ID ${classId})` });
        return;
      }

      // Việc BE/BF: chặn cứng nếu BẤT KỲ giảng viên nào vượt định mức giờ dạy/tuần hoặc/năm — loại
      // trừ chính MergedSessionId đang tạo (các dòng sibling khác lớp cùng buổi ghép này không tính trùng).
      for (const teacherId of teacherIds) {
        const weeklyHoursCheck = await checkTeacherWeeklyHours({
          teacherId, scheduleDate, roomId, startTime, endTime, excludeMergedSessionId: mergedSessionId,
        });
        if (weeklyHoursCheck.violated) {
          for (const scheduleId of scheduleIds) {
            await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
          }
          await pool.request().input("id", sql.Int, mergedSessionId).query(`DELETE FROM MergedSessions WHERE MergedSessionId=@id`);
          res.status(400).json({ message: `${weeklyHoursCheck.message} (lớp ID ${classId})` });
          return;
        }
        const yearlyHoursCheck = await checkTeacherYearlyHours({
          teacherId, scheduleDate, roomId, startTime, endTime, excludeMergedSessionId: mergedSessionId,
        });
        if (yearlyHoursCheck.violated) {
          for (const scheduleId of scheduleIds) {
            await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
          }
          await pool.request().input("id", sql.Int, mergedSessionId).query(`DELETE FROM MergedSessions WHERE MergedSessionId=@id`);
          res.status(400).json({ message: `${yearlyHoursCheck.message} (lớp ID ${classId})` });
          return;
        }
      }

      const result = await pool
        .request()
        .input("semesterId", sql.Int, semesterId)
        .input("classId", sql.Int, classId)
        .input("subjectId", sql.Int, subjectId)
        .input("roomId", sql.Int, roomId)
        .input("scheduleDate", sql.Date, scheduleDate)
        .input("startTime", sql.VarChar, startTime)
        .input("endTime", sql.VarChar, endTime)
        .input("note", sql.NVarChar, note || null)
        .input("sessionType", sql.NVarChar, sessionType || null)
        .input("mergedSessionId", sql.Int, mergedSessionId)
        .input("createdBy", sql.Int, req.user!.userId)
        .query<{ ScheduleId: number }>(`
          INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, SessionType, MergedSessionId, CreatedBy)
          OUTPUT INSERTED.ScheduleId
          VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @sessionType, @mergedSessionId, @createdBy)
        `);
      const scheduleId = result.recordset[0].ScheduleId;
      scheduleIds.push(scheduleId);

      for (const teacherId of teacherIds) {
        await pool
          .request()
          .input("scheduleId", sql.Int, scheduleId)
          .input("teacherId", sql.Int, teacherId)
          .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
      }
    }

    await writeAuditLog({
      userId: req.user!.userId, action: "Insert", tableName: "MergedSessions",
      recordId: mergedSessionId, detail: req.body,
    });

    // Việc CA: Lịch nghỉ tính theo hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride) —
    // classTrainingInfos ở trên là hệ HIỆU LỰC (ưu tiên override), chỉ đúng cho kiểm tra "ghép được
    // không" (checkTrainingModeRule-tương-đương), không dùng lại cho nghỉ lễ.
    const majorClassInfo = await getClassMajorTrainingMode(classIds[0]);
    const holiday = await findHoliday(scheduleDate, majorClassInfo?.trainingMode);
    const examPeriodWarning = await checkExamPeriodWarning(semesterId, scheduleDate);

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    warnings.push(...new Set(trainingWarnings));
    if (examPeriodWarning) warnings.push(examPeriodWarning);

    res.status(201).json({
      mergedSessionId,
      scheduleIds,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}

interface CopyWeekBody {
  classId?: number;
  sourceWeekStart?: string;
  targetWeekStart?: string;
}

// YYYY-MM-DD + offset ngày -> YYYY-MM-DD mới, tính theo UTC để tránh lệch múi giờ server
// (cùng cách làm với getWeekday trong trainingModeCheck.ts).
function shiftDateStr(dateStr: string, offsetDays: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// Sao chép lịch (XLTB-04): copy toàn bộ buổi học của 1 Lớp trong tuần nguồn sang tuần đích,
// giữ nguyên giờ/phòng/GV/GroupLabel, chỉ dịch ScheduleDate theo đúng offset số ngày giữa 2 tuần.
// Mỗi buổi vẫn phải qua đủ các kiểm tra như tạo lịch thường (nghỉ lễ / xung đột / sĩ số / hệ đào
// tạo) — buổi nào vướng thì BỎ QUA (không tạo, ghi lý do) thay vì chặn cả loạt.
export async function copyWeek(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, sourceWeekStart, targetWeekStart } = req.body as CopyWeekBody;
    if (!classId || !sourceWeekStart || !targetWeekStart) {
      res.status(400).json({ message: "Thiếu lớp hoặc tuần nguồn/tuần đích" });
      return;
    }

    const offsetDays = Math.round(
      (new Date(`${targetWeekStart}T00:00:00Z`).getTime() - new Date(`${sourceWeekStart}T00:00:00Z`).getTime())
        / (24 * 60 * 60 * 1000)
    );
    if (offsetDays === 0) {
      res.status(400).json({ message: "Tuần đích phải khác tuần nguồn" });
      return;
    }

    const pool = await getPool();
    const sourceWeekEnd = shiftDateStr(sourceWeekStart, 6);
    const sourceRowsResult = await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("weekStart", sql.Date, sourceWeekStart)
      .input("weekEnd", sql.Date, sourceWeekEnd)
      .query<{
        ScheduleId: number; SemesterId: number; SubjectId: number; RoomId: number;
        ScheduleDate: string; StartTime: string; EndTime: string;
        Note: string | null; GroupLabel: string | null;
      }>(`
        SELECT ScheduleId, SemesterId, SubjectId, RoomId,
               CONVERT(VARCHAR(10), ScheduleDate, 23) AS ScheduleDate,
               CONVERT(VARCHAR(5), StartTime, 108) AS StartTime,
               CONVERT(VARCHAR(5), EndTime, 108) AS EndTime,
               Note, GroupLabel
        FROM Schedule
        WHERE ClassId = @classId AND ScheduleDate BETWEEN @weekStart AND @weekEnd
        ORDER BY ScheduleDate, StartTime
      `);

    const sourceRows = sourceRowsResult.recordset;
    if (sourceRows.length === 0) {
      res.json({ created: 0, skippedHolidays: 0, skippedConflicts: [], message: "Tuần nguồn không có buổi học nào" });
      return;
    }

    // Việc CA: dùng cho Lịch nghỉ bên dưới — hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride).
    const majorClassInfo = await getClassMajorTrainingMode(classId);
    const classSize = await getClassSize(classId);

    let created = 0;
    let skippedHolidays = 0;
    const skippedConflicts: string[] = [];
    const notifiedTeacherIds = new Set<number>();

    for (const row of sourceRows) {
      const teacherResult = await pool
        .request()
        .input("scheduleId", sql.Int, row.ScheduleId)
        .query<{ TeacherId: number }>(`SELECT TeacherId FROM ScheduleTeachers WHERE ScheduleId = @scheduleId`);
      const teacherIds = teacherResult.recordset.map((t) => t.TeacherId);

      const newDate = shiftDateStr(row.ScheduleDate, offsetDays);

      const holiday = await findHoliday(newDate, majorClassInfo?.trainingMode);
      if (holiday) {
        skippedHolidays++;
        continue;
      }

      const conflict = await checkScheduleConflict({
        roomId: row.RoomId, teacherIds, date: newDate, startTime: row.StartTime, endTime: row.EndTime,
      });
      if (conflict.hasConflict) {
        skippedConflicts.push(`${row.StartTime}-${row.EndTime} ngày ${newDate}: ${conflictMessage(conflict)}`);
        continue;
      }

      // Việc BH: dòng nguồn ĐÃ tách nhóm (row.GroupLabel khác NULL) — kiểm tra sức chứa đúng theo sĩ
      // số RIÊNG của nhóm đó, không phải cả lớp.
      const capacityCheck = await checkRoomCapacity(
        await capacityCheckParamsFor(row.RoomId, classSize, row.GroupLabel, row.SubjectId)
      );
      if (capacityCheck.violated) {
        skippedConflicts.push(`${row.StartTime}-${row.EndTime} ngày ${newDate}: ${capacityCheck.message}`);
        continue;
      }

      const trainingCheck = await checkTrainingModeRule({ classId, scheduleDate: newDate, startTime: row.StartTime });
      if (trainingCheck.violated) {
        skippedConflicts.push(`${row.StartTime}-${row.EndTime} ngày ${newDate}: ${trainingCheck.message}`);
        continue;
      }

      // Việc BE/BF: chặn cứng nếu BẤT KỲ giảng viên nào vượt định mức giờ dạy/tuần hoặc/năm ở
      // tuần/năm đích mới — giữ đúng hành vi BỎ QUA buổi này (không hủy cả lần sao chép) như các
      // kiểm tra khác ở trên.
      let weeklyHoursViolated = false;
      for (const teacherId of teacherIds) {
        const weeklyHoursCheck = await checkTeacherWeeklyHours({
          teacherId, scheduleDate: newDate, roomId: row.RoomId, startTime: row.StartTime, endTime: row.EndTime,
        });
        if (weeklyHoursCheck.violated) {
          skippedConflicts.push(`${row.StartTime}-${row.EndTime} ngày ${newDate}: ${weeklyHoursCheck.message}`);
          weeklyHoursViolated = true;
          break;
        }
        const yearlyHoursCheck = await checkTeacherYearlyHours({
          teacherId, scheduleDate: newDate, roomId: row.RoomId, startTime: row.StartTime, endTime: row.EndTime,
        });
        if (yearlyHoursCheck.violated) {
          skippedConflicts.push(`${row.StartTime}-${row.EndTime} ngày ${newDate}: ${yearlyHoursCheck.message}`);
          weeklyHoursViolated = true;
          break;
        }
      }
      if (weeklyHoursViolated) continue;

      const insertResult = await pool
        .request()
        .input("semesterId", sql.Int, row.SemesterId)
        .input("classId", sql.Int, classId)
        .input("subjectId", sql.Int, row.SubjectId)
        .input("roomId", sql.Int, row.RoomId)
        .input("scheduleDate", sql.Date, newDate)
        .input("startTime", sql.VarChar, row.StartTime)
        .input("endTime", sql.VarChar, row.EndTime)
        .input("note", sql.NVarChar, row.Note)
        .input("groupLabel", sql.NVarChar, row.GroupLabel)
        .input("createdBy", sql.Int, req.user!.userId)
        .query<{ ScheduleId: number }>(`
          INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, GroupLabel, CreatedBy)
          OUTPUT INSERTED.ScheduleId
          VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @groupLabel, @createdBy)
        `);
      const newScheduleId = insertResult.recordset[0].ScheduleId;

      for (const teacherId of teacherIds) {
        await pool
          .request()
          .input("scheduleId", sql.Int, newScheduleId)
          .input("teacherId", sql.Int, teacherId)
          .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
      }
      created++;
      teacherIds.forEach((t) => notifiedTeacherIds.add(t));
    }

    await writeAuditLog({
      userId: req.user!.userId, action: "Insert", tableName: "Schedule",
      recordId: null, detail: { classId, sourceWeekStart, targetWeekStart, created, skippedHolidays, skippedConflicts },
    });

    // Sao chép cả tuần có thể tạo nhiều dòng Schedule cho cùng 1 GV — chỉ gửi 1 thông báo tổng
    // hợp/GV thay vì gửi riêng từng buổi để tránh spam thông báo.
    if (created > 0 && notifiedTeacherIds.size > 0) {
      await notifyTeachers(
        Array.from(notifiedTeacherIds),
        `TKB lớp ${majorClassInfo?.className ?? classId} tuần ${targetWeekStart} đã được cập nhật, ${created} tiết mới`,
        "Schedule",
        null
      );
    }

    res.status(201).json({ created, skippedHolidays, skippedConflicts });
  } catch (err) {
    next(err);
  }
}

// Việc BL: xóa TOÀN BỘ Schedule (tiết học thường) của 1 Lớp trong đúng 1 tuần (Thứ 2 - Chủ nhật, tính
// từ weekStart) chỉ 1 lần bấm — hữu ích khi cần dọn sạch để xếp lại (đặc biệt lúc thử nghiệm thuật
// toán tự động). CHỈ xóa Schedule — không động tới Exams (lịch thi vẫn xóa riêng qua trang Lịch thi
// như bình thường, kể cả khi đã hiển thị chung trên lịch từ Việc BI). ScheduleTeachers tự xóa theo
// ON DELETE CASCADE, không cần xóa tay (cùng cách cancelAutoScheduleRun đang làm).
export async function deleteWeek(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, weekStart } = req.query as Record<string, string | undefined>;
    if (!classId || !weekStart) {
      res.status(400).json({ message: "Thiếu classId hoặc weekStart" });
      return;
    }
    const weekEnd = shiftDateStr(weekStart, 6);
    const pool = await getPool();

    const idsResult = await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("weekStart", sql.Date, weekStart)
      .input("weekEnd", sql.Date, weekEnd)
      .query<{ ScheduleId: number }>(`
        SELECT ScheduleId FROM Schedule WHERE ClassId = @classId AND ScheduleDate BETWEEN @weekStart AND @weekEnd
      `);
    const scheduleIds = idsResult.recordset.map((r) => r.ScheduleId);
    if (scheduleIds.length === 0) {
      res.json({ deletedCount: 0 });
      return;
    }

    await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("weekStart", sql.Date, weekStart)
      .input("weekEnd", sql.Date, weekEnd)
      .query(`DELETE FROM Schedule WHERE ClassId = @classId AND ScheduleDate BETWEEN @weekStart AND @weekEnd`);

    await writeAuditLog({
      userId: req.user!.userId, action: "Delete", tableName: "Schedule",
      recordId: null, detail: { classId: Number(classId), weekStart, weekEnd, deletedCount: scheduleIds.length, scheduleIds },
    });

    res.json({ deletedCount: scheduleIds.length });
  } catch (err) {
    next(err);
  }
}

// Việc BS: xóa TOÀN BỘ Schedule (tiết học thường) của 1 Lớp trong CẢ 1 Kỳ (mọi tuần) chỉ 1 lần bấm —
// hữu ích khi cần dọn sạch để xếp lại từ đầu (đặc biệt sau nhiều lần thử nghiệm thuật toán tự động).
// Lọc thẳng theo Schedule.SemesterId (cách liên kết Schedule-Semester đã có sẵn, không cần suy theo
// khoảng ngày StartDate-EndDate như deleteWeek phải làm vì không có cột Semester trực tiếp ở đó theo
// tuần cụ thể). CHỈ xóa Schedule — không động tới Exams, cùng nguyên tắc deleteWeek ở trên.
export async function deleteSemester(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, semesterId } = req.query as Record<string, string | undefined>;
    if (!classId || !semesterId) {
      res.status(400).json({ message: "Thiếu classId hoặc semesterId" });
      return;
    }
    const pool = await getPool();

    const idsResult = await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("semesterId", sql.Int, semesterId)
      .query<{ ScheduleId: number }>(`
        SELECT ScheduleId FROM Schedule WHERE ClassId = @classId AND SemesterId = @semesterId
      `);
    const scheduleIds = idsResult.recordset.map((r) => r.ScheduleId);
    if (scheduleIds.length === 0) {
      res.json({ deletedCount: 0 });
      return;
    }

    await pool
      .request()
      .input("classId", sql.Int, classId)
      .input("semesterId", sql.Int, semesterId)
      .query(`DELETE FROM Schedule WHERE ClassId = @classId AND SemesterId = @semesterId`);

    await writeAuditLog({
      userId: req.user!.userId, action: "Delete", tableName: "Schedule",
      recordId: null, detail: { classId: Number(classId), semesterId: Number(semesterId), deletedCount: scheduleIds.length, scheduleIds },
    });

    res.json({ deletedCount: scheduleIds.length });
  } catch (err) {
    next(err);
  }
}

interface GroupedScheduleGroup {
  groupLabel?: string;
  roomId?: number;
  teacherIds?: number[];
  scheduleDate?: string;
  startTime?: string;
  endTime?: string;
}

interface GroupedScheduleBody {
  semesterId?: number;
  classId?: number;
  subjectId?: number;
  note?: string;
  isMakeup?: boolean;
  sessionType?: string;
  groups?: GroupedScheduleGroup[];
}

// Tách nhóm: 1 lớp học Thực hành/Lâm sàng vượt sĩ số/phòng được chia thành nhiều nhóm, mỗi nhóm 1
// dòng Schedule riêng cùng ClassId/SubjectId nhưng khác GroupLabel. Vì các nhóm không dùng chung
// MergedSessionId (khác bản chất với ghép lớp) nên không bắt buộc học CÙNG LÚC — Việc AY: mỗi
// nhóm có thể tự chọn Ngày+Ca riêng để XOAY VÒNG dùng chung 1 phòng (vd trường chỉ có 1 phòng thực
// hành, 3 nhóm học các buổi khác nhau thay vì bắt buộc cùng giờ).
export async function groupedCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId, classId, subjectId, note, isMakeup, sessionType, groups = [] } = req.body as GroupedScheduleBody;

    if (!semesterId || !classId || !subjectId || !Array.isArray(groups) || groups.length < 2) {
      res.status(400).json({ message: "Cần chọn ít nhất 2 nhóm và đủ thông tin bắt buộc để tách nhóm" });
      return;
    }
    for (const group of groups) {
      if (!group.groupLabel?.trim() || !group.roomId || !group.scheduleDate || !group.startTime || !group.endTime) {
        res.status(400).json({ message: `Nhóm "${group.groupLabel || "?"}" cần có đủ Tên nhóm, Ngày, Ca và Phòng học` });
        return;
      }
    }
    const labels = groups.map((g) => g.groupLabel!.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) {
      res.status(400).json({ message: "Tên nhóm bị trùng — mỗi nhóm cần đặt 1 tên riêng" });
      return;
    }

    // Việc CA: dùng cho Lịch nghỉ bên dưới — hệ đào tạo GỐC của Ngành (KHÔNG qua SchedulePatternOverride).
    const majorClassInfo = await getClassMajorTrainingMode(classId);
    const pool = await getPool();
    const scheduleIds: number[] = [];
    const warnings: string[] = [];

    // Việc AY: mỗi nhóm có Ngày/Ca riêng nên MỌI kiểm tra (xung đột, độ dài buổi, tổng giờ/ngày,
    // nghỉ lễ, hệ đào tạo) phải chạy ĐÚNG theo ngày/giờ của TỪNG nhóm — không dùng chung 1 kết quả
    // cho cả loạt như trước. Kiểm tra + insert xen kẽ TRONG CÙNG vòng lặp (không tách pha) để nhóm
    // sau thấy đúng dữ liệu đã lưu của nhóm trước (vd 2 nhóm cùng ngày cộng dồn đúng vào tổng giờ/
    // ngày) — nhóm nào vi phạm thì rollback các nhóm đã tạo trước đó trong lần tách nhóm này, báo
    // rõ đúng tên nhóm gây lỗi (giữ hành vi tất cả-hoặc-không-gì-cả như checkScheduleConflict).
    for (const group of groups) {
      const conflict = await checkScheduleConflict({
        roomId: group.roomId!, teacherIds: group.teacherIds || [],
        date: group.scheduleDate!, startTime: group.startTime!, endTime: group.endTime!,
      });
      if (conflict.hasConflict) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        res.status(409).json({
          message: `${conflictMessage(conflict)} (nhóm "${group.groupLabel}")`,
          conflict,
        });
        return;
      }

      // Việc BR: mỗi nhóm tự chọn Phòng riêng nên kiểm tra SubjectRooms theo ĐÚNG Phòng của TỪNG nhóm.
      const subjectRoomCheck = await checkSubjectRoom({ subjectId, roomId: group.roomId!, sessionType });
      if (subjectRoomCheck.violated) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        res.status(400).json({ message: `${subjectRoomCheck.message} (nhóm "${group.groupLabel}")` });
        return;
      }

      const sessionLengthCheck = await checkSessionLength({
        roomId: group.roomId!, startTime: group.startTime!, endTime: group.endTime!,
      });
      if (sessionLengthCheck.violated) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        res.status(400).json({ message: `${sessionLengthCheck.message} (nhóm "${group.groupLabel}")` });
        return;
      }

      const dailyHoursCheck = await checkDailyHoursLimit({
        classId, scheduleDate: group.scheduleDate!, roomId: group.roomId!,
        startTime: group.startTime!, endTime: group.endTime!,
      });
      if (dailyHoursCheck.violated) {
        for (const scheduleId of scheduleIds) {
          await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
        }
        res.status(400).json({ message: `${dailyHoursCheck.message} (nhóm "${group.groupLabel}")` });
        return;
      }

      // Việc BE/BF: chặn cứng nếu BẤT KỲ giảng viên nào của nhóm này vượt định mức giờ dạy/tuần
      // hoặc/năm — KHÔNG loại trừ GroupBatchId (khác Ghép lớp): các nhóm tách ra thường học ở
      // NGÀY/CA KHÁC NHAU nên vẫn là giờ dạy thật riêng biệt, phải cộng dồn đủ qua từng nhóm.
      for (const teacherId of group.teacherIds || []) {
        const weeklyHoursCheck = await checkTeacherWeeklyHours({
          teacherId, scheduleDate: group.scheduleDate!, roomId: group.roomId!,
          startTime: group.startTime!, endTime: group.endTime!,
        });
        if (weeklyHoursCheck.violated) {
          for (const scheduleId of scheduleIds) {
            await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
          }
          res.status(400).json({ message: `${weeklyHoursCheck.message} (nhóm "${group.groupLabel}")` });
          return;
        }
        const yearlyHoursCheck = await checkTeacherYearlyHours({
          teacherId, scheduleDate: group.scheduleDate!, roomId: group.roomId!,
          startTime: group.startTime!, endTime: group.endTime!,
        });
        if (yearlyHoursCheck.violated) {
          for (const scheduleId of scheduleIds) {
            await pool.request().input("id", sql.Int, scheduleId).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
          }
          res.status(400).json({ message: `${yearlyHoursCheck.message} (nhóm "${group.groupLabel}")` });
          return;
        }
      }

      const holiday = await findHoliday(group.scheduleDate!, majorClassInfo?.trainingMode);
      if (holiday) warnings.push(`Nhóm "${group.groupLabel}" ngày ${group.scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);

      const trainingCheck = await checkTrainingModeRule({
        classId, scheduleDate: group.scheduleDate!, startTime: group.startTime!, isMakeup,
      });
      if (trainingCheck.violated) warnings.push(`Nhóm "${group.groupLabel}": ${trainingCheck.message}`);

      const examPeriodWarning = await checkExamPeriodWarning(semesterId, group.scheduleDate!);
      if (examPeriodWarning) warnings.push(`Nhóm "${group.groupLabel}": ${examPeriodWarning}`);

      const result = await pool
        .request()
        .input("semesterId", sql.Int, semesterId)
        .input("classId", sql.Int, classId)
        .input("subjectId", sql.Int, subjectId)
        .input("roomId", sql.Int, group.roomId)
        .input("scheduleDate", sql.Date, group.scheduleDate)
        .input("startTime", sql.VarChar, group.startTime)
        .input("endTime", sql.VarChar, group.endTime)
        .input("note", sql.NVarChar, note || null)
        .input("sessionType", sql.NVarChar, sessionType || null)
        .input("groupLabel", sql.NVarChar, group.groupLabel!.trim())
        .input("createdBy", sql.Int, req.user!.userId)
        .query<{ ScheduleId: number }>(`
          INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, SessionType, GroupLabel, CreatedBy)
          OUTPUT INSERTED.ScheduleId
          VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @sessionType, @groupLabel, @createdBy)
        `);
      const scheduleId = result.recordset[0].ScheduleId;
      scheduleIds.push(scheduleId);

      for (const teacherId of group.teacherIds || []) {
        await pool
          .request()
          .input("scheduleId", sql.Int, scheduleId)
          .input("teacherId", sql.Int, teacherId)
          .query(`INSERT INTO ScheduleTeachers (ScheduleId, TeacherId) VALUES (@scheduleId, @teacherId)`);
      }
    }

    // Việc BB: đánh dấu mọi dòng vừa tạo trong lần tách nhóm này cùng 1 GroupBatchId (= ScheduleId
    // của nhóm đầu tiên) — dùng để tính TIẾN ĐỘ môn học không đếm trùng, vì các nhóm học song
    // song/xoay vòng thực chất chỉ là 1 buổi học, không phải nhiều buổi lặp lại (getPeriodTimelineForSubject).
    const groupBatchId = scheduleIds[0];
    const batchRequest = pool.request().input("batchId", sql.Int, groupBatchId);
    const idPlaceholders = scheduleIds
      .map((id, i) => {
        batchRequest.input(`sid${i}`, sql.Int, id);
        return `@sid${i}`;
      })
      .join(", ");
    await batchRequest.query(`UPDATE Schedule SET GroupBatchId = @batchId WHERE ScheduleId IN (${idPlaceholders})`);

    await writeAuditLog({
      userId: req.user!.userId, action: "Insert", tableName: "Schedule",
      recordId: scheduleIds[0], detail: req.body,
    });

    res.status(201).json({
      scheduleIds,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}
