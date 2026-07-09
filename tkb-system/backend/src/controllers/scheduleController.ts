import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { checkScheduleConflict, findHoliday } from "../utils/conflictCheck";
import { checkTrainingModeRule, getClassTrainingMode } from "../utils/trainingModeCheck";
import { checkRoomCapacity, checkSessionLength, checkDailyHoursLimit, getClassSize } from "../utils/policyRules";
import { writeAuditLog } from "../utils/auditLog";
import { AuthRequest } from "../types";

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
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { semesterId, classId, teacherId, roomId, from, to } = req.query as Record<string, string | undefined>;
    const pool = await getPool();
    const request = pool.request();

    let where = "WHERE 1=1";
    if (semesterId) { request.input("semesterId", sql.Int, semesterId); where += " AND s.SemesterId=@semesterId"; }
    if (classId) { request.input("classId", sql.Int, classId); where += " AND s.ClassId=@classId"; }
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

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classId, subjectId, roomId, teacherIds = [],
      scheduleDate, startTime, endTime, note, isMakeup,
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
    const capacityCheck = await checkRoomCapacity({ roomId, totalStudents: classSize });
    if (capacityCheck.violated) {
      res.status(400).json({ message: capacityCheck.message });
      return;
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
      .input("createdBy", sql.Int, req.user!.userId)
      .query<{ ScheduleId: number }>(`
        INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, CreatedBy)
        OUTPUT INSERTED.ScheduleId
        VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @createdBy)
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

    const classInfo = await getClassTrainingMode(classId);
    const holiday = await findHoliday(scheduleDate, classInfo?.trainingMode);
    const trainingCheck = await checkTrainingModeRule({
      classId, scheduleDate, startTime, isMakeup,
    });
    const sessionLengthCheck = await checkSessionLength({ roomId, startTime, endTime });
    const dailyHoursCheck = await checkDailyHoursLimit({
      classId, scheduleDate, roomId, startTime, endTime, excludeScheduleId: scheduleId,
    });

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (trainingCheck.violated) warnings.push(trainingCheck.message!);
    if (sessionLengthCheck.violated) warnings.push(sessionLengthCheck.message!);
    if (dailyHoursCheck.violated) warnings.push(dailyHoursCheck.message!);

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
      scheduleDate, startTime, endTime, note, isMakeup,
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
    const capacityCheck = await checkRoomCapacity({ roomId: roomId as number, totalStudents: classSize });
    if (capacityCheck.violated) {
      res.status(400).json({ message: capacityCheck.message });
      return;
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
      .query(`
        UPDATE Schedule SET ClassId=@classId, SubjectId=@subjectId, RoomId=@roomId,
          ScheduleDate=@scheduleDate, StartTime=@startTime, EndTime=@endTime,
          Note=@note, UpdatedAt=SYSDATETIME()
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

    const classInfo = await getClassTrainingMode(classId as number);
    const holiday = await findHoliday(scheduleDate as string, classInfo?.trainingMode);
    const trainingCheck = await checkTrainingModeRule({
      classId: classId as number, scheduleDate: scheduleDate as string, startTime: startTime as string,
      isMakeup, excludeScheduleId: Number(id),
    });
    const sessionLengthCheck = await checkSessionLength({
      roomId: roomId as number, startTime: startTime as string, endTime: endTime as string,
    });
    const dailyHoursCheck = await checkDailyHoursLimit({
      classId: classId as number, scheduleDate: scheduleDate as string, roomId: roomId as number,
      startTime: startTime as string, endTime: endTime as string, excludeScheduleId: Number(id),
    });

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (trainingCheck.violated) warnings.push(trainingCheck.message!);
    if (sessionLengthCheck.violated) warnings.push(sessionLengthCheck.message!);
    if (dailyHoursCheck.violated) warnings.push(dailyHoursCheck.message!);

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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Schedule WHERE ScheduleId=@id`);
    await writeAuditLog({ userId: req.user!.userId, action: "Delete", tableName: "Schedule", recordId: Number(id) });
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
}

// Ghép lớp: nhiều lớp cùng học 1 buổi (chung phòng/giờ/giảng viên). Tạo 1 dòng
// MergedSessions rồi tạo N dòng Schedule (1 dòng/lớp) cùng trỏ về MergedSessionId đó.
// Các dòng cùng MergedSessionId cố tình trùng phòng/giờ nên checkScheduleConflict phải
// loại trừ chúng khi so với nhau — chỉ chặn nếu trùng với lịch KHÁC ngoài buổi ghép này.
export async function mergedCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classIds = [], subjectId, roomId, teacherIds = [],
      scheduleDate, startTime, endTime, note, isMakeup,
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

      const dailyHoursCheck = await checkDailyHoursLimit({
        classId, scheduleDate, roomId, startTime, endTime, excludeMergedSessionId: mergedSessionId,
      });
      if (dailyHoursCheck.violated) trainingWarnings.push(dailyHoursCheck.message!);

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
        .input("mergedSessionId", sql.Int, mergedSessionId)
        .input("createdBy", sql.Int, req.user!.userId)
        .query<{ ScheduleId: number }>(`
          INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, MergedSessionId, CreatedBy)
          OUTPUT INSERTED.ScheduleId
          VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @mergedSessionId, @createdBy)
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

    const holiday = await findHoliday(scheduleDate, classTrainingInfos[0]?.trainingMode);
    const sessionLengthCheck = await checkSessionLength({ roomId, startTime, endTime });

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (sessionLengthCheck.violated) warnings.push(sessionLengthCheck.message!);
    warnings.push(...new Set(trainingWarnings));

    res.status(201).json({
      mergedSessionId,
      scheduleIds,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}

interface GroupedScheduleGroup {
  groupLabel?: string;
  roomId?: number;
  teacherIds?: number[];
}

interface GroupedScheduleBody {
  semesterId?: number;
  classId?: number;
  subjectId?: number;
  scheduleDate?: string;
  startTime?: string;
  endTime?: string;
  note?: string;
  isMakeup?: boolean;
  groups?: GroupedScheduleGroup[];
}

// Tách nhóm: 1 lớp học Thực hành/Lâm sàng vượt sĩ số/phòng được chia thành nhiều nhóm học
// SONG SONG cùng ngày/giờ (khác Phòng và/hoặc Giảng viên), mỗi nhóm là 1 dòng Schedule riêng
// cùng ClassId/SubjectId/ScheduleDate nhưng khác GroupLabel. Vì các nhóm học cùng lúc ở phòng
// khác nhau nên không dùng chung MergedSessionId (khác bản chất với ghép lớp — ghép lớp là
// NHIỀU LỚP gộp vào 1 buổi/1 phòng; tách nhóm là 1 LỚP chia nhỏ ra NHIỀU phòng cùng lúc).
export async function groupedCreate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      semesterId, classId, subjectId, scheduleDate, startTime, endTime, note, isMakeup, groups = [],
    } = req.body as GroupedScheduleBody;

    if (!semesterId || !classId || !subjectId || !scheduleDate || !startTime || !endTime
      || !Array.isArray(groups) || groups.length < 2) {
      res.status(400).json({ message: "Cần chọn ít nhất 2 nhóm và đủ thông tin bắt buộc để tách nhóm" });
      return;
    }
    for (const group of groups) {
      if (!group.groupLabel?.trim() || !group.roomId) {
        res.status(400).json({ message: "Mỗi nhóm cần có tên nhóm và phòng học" });
        return;
      }
    }
    const labels = groups.map((g) => g.groupLabel!.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) {
      res.status(400).json({ message: "Tên nhóm bị trùng — mỗi nhóm cần đặt 1 tên riêng" });
      return;
    }

    // Cảnh báo (nghỉ lễ / hệ đào tạo / độ dài buổi / tổng giờ trong ngày) tính TRƯỚC khi tạo bất
    // kỳ dòng Schedule nào của lần tách nhóm này — vì các nhóm học SONG SONG cùng giờ nên với lớp,
    // đây tính là 1 buổi duy nhất trong ngày, không phải cộng dồn thời lượng của từng nhóm.
    const classInfo = await getClassTrainingMode(classId);
    const holiday = await findHoliday(scheduleDate, classInfo?.trainingMode);
    const trainingCheck = await checkTrainingModeRule({ classId, scheduleDate, startTime, isMakeup });
    const representativeRoomId = groups[0].roomId!;
    const sessionLengthCheck = await checkSessionLength({ roomId: representativeRoomId, startTime, endTime });
    const dailyHoursCheck = await checkDailyHoursLimit({
      classId, scheduleDate, roomId: representativeRoomId, startTime, endTime,
    });

    const pool = await getPool();
    const scheduleIds: number[] = [];

    for (const group of groups) {
      const conflict = await checkScheduleConflict({
        roomId: group.roomId!, teacherIds: group.teacherIds || [], date: scheduleDate, startTime, endTime,
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

      const result = await pool
        .request()
        .input("semesterId", sql.Int, semesterId)
        .input("classId", sql.Int, classId)
        .input("subjectId", sql.Int, subjectId)
        .input("roomId", sql.Int, group.roomId)
        .input("scheduleDate", sql.Date, scheduleDate)
        .input("startTime", sql.VarChar, startTime)
        .input("endTime", sql.VarChar, endTime)
        .input("note", sql.NVarChar, note || null)
        .input("groupLabel", sql.NVarChar, group.groupLabel!.trim())
        .input("createdBy", sql.Int, req.user!.userId)
        .query<{ ScheduleId: number }>(`
          INSERT INTO Schedule (SemesterId, ClassId, SubjectId, RoomId, ScheduleDate, StartTime, EndTime, Note, GroupLabel, CreatedBy)
          OUTPUT INSERTED.ScheduleId
          VALUES (@semesterId, @classId, @subjectId, @roomId, @scheduleDate, @startTime, @endTime, @note, @groupLabel, @createdBy)
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

    await writeAuditLog({
      userId: req.user!.userId, action: "Insert", tableName: "Schedule",
      recordId: scheduleIds[0], detail: req.body,
    });

    const warnings: string[] = [];
    if (holiday) warnings.push(`Ngày ${scheduleDate} rơi vào ngày nghỉ lễ: ${holiday.Description}`);
    if (trainingCheck.violated) warnings.push(trainingCheck.message!);
    if (sessionLengthCheck.violated) warnings.push(sessionLengthCheck.message!);
    if (dailyHoursCheck.violated) warnings.push(dailyHoursCheck.message!);

    res.status(201).json({
      scheduleIds,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    });
  } catch (err) {
    next(err);
  }
}
