import { Request } from "express";

export type UserRole = "Admin" | "Teacher";

export interface JwtPayload {
  userId: number;
  username: string;
  role: UserRole;
  teacherId: number | null;
}

// Request đã qua middleware authenticate sẽ có req.user
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export interface ConflictRecord {
  [key: string]: unknown;
}

export interface ScheduleConflictResult {
  hasConflict: boolean;
  roomConflicts: ConflictRecord[];
  teacherConflicts: ConflictRecord[];
  roomUnavailable: ConflictRecord[];
  teacherUnavailable: ConflictRecord[];
}

export interface ExamConflictResult {
  hasConflict: boolean;
  roomConflicts: ConflictRecord[];
  proctorConflicts: ConflictRecord[];
  roomUnavailable: ConflictRecord[];
  teacherUnavailable: ConflictRecord[];
}

export interface HolidayRecord {
  HolidayId: number;
  DateFrom: string;
  DateTo: string;
  Description: string;
  AppliesTo: "CQ" | "LT" | "ALL";
}

export interface HttpError extends Error {
  status?: number;
}

export interface AuditLogInput {
  userId?: number | null;
  action: "Insert" | "Update" | "Delete";
  tableName: string;
  recordId?: number | null;
  detail?: unknown;
}
