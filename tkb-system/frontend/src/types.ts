export type UserRole = "Admin" | "Teacher";

export interface AuthUser {
  userId: number;
  username: string;
  role: UserRole;
  teacherId: number | null;
}

export interface Major {
  MajorId: number;
  MajorName: string;
  TrainingMode: "CQ" | "LT" | null;
  FacultyId: number | null;
  FacultyName: string | null;
  IsActive: boolean;
}

export interface Cohort {
  CohortId: number;
  CohortName: string;
  StartYear: number;
  DurationYears: number;
  IsActive: boolean;
}

export interface Faculty {
  FacultyId: number;
  FacultyName: string;
  IsActive: boolean;
}

export interface Position {
  PositionId: number;
  PositionName: string;
  IsActive: boolean;
}

export interface Teacher {
  TeacherId: number;
  FullName: string;
  FacultyId: number | null;
  FacultyName: string | null;
  PositionId: number | null;
  PositionName: string | null;
  Phone: string | null;
  Email: string | null;
  IsActive: boolean;
  Subjects: string | null;
}

export interface TeacherDetail extends Teacher {
  subjects: { SubjectId: number; SubjectName: string }[];
}

export interface Subject {
  SubjectId: number;
  SubjectCode: string | null;
  SubjectName: string;
  FacultyId: number | null;
  FacultyName: string | null;
  MajorId: number | null;
  MajorName: string | null;
  // Phân loại môn theo khối kiến thức: DaiCuong | CoSoNganh | ChuyenNganh | null (chưa phân loại).
  Category: string | null;
  Credits: number | null;
  TheoryHours: number;
  PracticeHours: number;
  ExamHours: number;
  IsActive: boolean;
  // Việc BT: môn Thực hành/Lâm sàng có CẦN chia nhóm theo bảng mốc sĩ số hay không — mặc định true.
  RequiresGrouping: boolean;
}

export interface CurriculumItem {
  CurriculumItemId: number;
  MajorId: number;
  MajorName: string;
  SubjectId: number;
  SubjectName: string;
  SubjectCode: string | null;
  CohortId: number | null;
  CohortName: string | null;
  TermNumber: number;
  Credits: number | null;
  TotalHours: number | null;
  TheoryHours: number | null;
  PracticeHours: number | null;
  ExamHours: number | null;
  // Việc BA: hình thức dạy phần Thực hành của môn — ThucHanh (mặc định, phòng thực hành/60p/tiết),
  // LyThuyet (dạy tại phòng lý thuyết, 45p/tiết nhưng vẫn tính vào chỉ tiêu Thực hành), LamSang.
  PracticeMode: "LyThuyet" | "ThucHanh" | "LamSang";
  SortOrder: number;
  IsActive: boolean;
}

export interface SchoolClass {
  ClassId: number;
  ClassName: string;
  MajorId: number;
  MajorName: string;
  TrainingMode: "CQ" | "LT" | null;
  // Việc AZ: ghi đè kiểu lịch học riêng cho lớp này (vd văn bằng 2) — CHỈ ảnh hưởng kiểm tra
  // ngày/buổi khi xếp lịch, không đổi Hệ đào tạo thật (TrainingMode) của Ngành.
  SchedulePatternOverride: "CQ" | "LT" | null;
  CohortId: number;
  CohortName: string;
  ClassSize: number;
  StartDate: string | null;
  IsActive: boolean;
}

export type RoomType = "LyThuyet" | "ThucHanh" | "Labo" | "LamSang" | "SanBai";

export interface Room {
  RoomId: number;
  RoomName: string;
  RoomType: RoomType;
  Capacity: number | null;
  FacultyId: number | null;
  FacultyName: string | null;
  IsActive: boolean;
}

export interface RoomUnavailability {
  UnavailabilityId: number;
  RoomId: number;
  RoomName: string;
  DateFrom: string;
  DateTo: string;
  Reason: string | null;
  CreatedAt: string;
}

export interface TeacherUnavailability {
  UnavailabilityId: number;
  TeacherId: number;
  FullName: string;
  DateFrom: string;
  DateTo: string;
  Reason: string | null;
  CreatedAt: string;
}

export interface Semester {
  SemesterId: number;
  SemesterName: string;
  AcademicYear: string;
  StartDate: string;
  EndDate: string;
  // Việc BG: hạn cuối xếp tiết học thường — sau ngày này dành riêng cho thi cuối kỳ. NULL với Kỳ
  // thêm thủ công chưa điền, hoặc chưa từng chạy "Tự động tạo các Kỳ".
  TeachingEndDate: string | null;
  ClassId: number | null;
  TermNumber: number | null;
  IsActive: boolean;
}

export interface GeneratedTerm {
  semesterId: number;
  termNumber: number;
  semesterName: string;
  startDate: string;
  endDate: string;
}

export type HolidayAppliesTo = "CQ" | "LT" | "ALL";

export interface Holiday {
  HolidayId: number;
  DateFrom: string;
  DateTo: string;
  Description: string;
  AppliesTo: HolidayAppliesTo;
}

export interface Session {
  SessionId: number;
  SessionName: string;
  StartTime: string;
  EndTime: string;
  SortOrder: number;
  IsActive: boolean;
}

export interface ScheduleItem {
  ScheduleId: number;
  SemesterId: number;
  ClassId: number;
  ClassName: string;
  SubjectId: number;
  SubjectName: string;
  RoomId: number;
  RoomName: string;
  ScheduleDate: string;
  StartTime: string;
  EndTime: string;
  Note: string | null;
  MergedSessionId: number | null;
  GroupLabel: string | null;
  Teachers: string | null;
}

// Việc AU: chi tiết đầy đủ 1 buổi học (dùng khi Sửa) — kèm TeacherId thật (không chỉ tên gộp
// chuỗi như ScheduleItem) và tiến độ số tiết LŨY KẾ ĐẾN ĐÚNG BUỔI NÀY (không phải tổng chung cho
// mọi buổi cùng môn — mỗi buổi có tiến độ riêng theo đúng thứ tự thời gian của nó).
// Việc AV: Lý thuyết và Thực hành theo dõi RIÊNG (không gộp 1 tổng — gộp sẽ báo nhầm đủ điều kiện
// thi dù mới xếp toàn Lý thuyết, chưa xếp Thực hành nào).
export interface ScheduleDetail {
  ScheduleId: number;
  ClassId: number;
  ClassName: string;
  // Việc BA: cần để tra lại PracticeMode của môn (CurriculumItems) khi mở form Sửa, vì lúc đó
  // form.semesterId bị bỏ trống nên không suy ra được TermNumber theo cách thông thường.
  MajorId: number;
  CohortId: number | null;
  TermNumber: number | null;
  SubjectId: number;
  SubjectName: string;
  RoomId: number;
  RoomName: string;
  RoomType: RoomType;
  ScheduleDate: string;
  StartTime: string;
  EndTime: string;
  Note: string | null;
  MergedSessionId: number | null;
  GroupLabel: string | null;
  // Việc BA: "Theory"/"Practice" do người dùng chọn tường minh khi xếp lịch; NULL cho dữ liệu xếp
  // từ trước (khi mở form Sửa buổi cũ, cần tự suy luận lại từ RoomType).
  SessionType: "Theory" | "Practice" | null;
  teacherIds: number[];
  theoryTarget: number;
  practiceTarget: number;
  periodsThisSession: number;
  cumulativeTheoryPeriods: number;
  cumulativePracticePeriods: number;
}

// Việc AU (fix) + Việc AV: tiến độ số tiết của 1 buổi cụ thể trong lưới lịch — trả theo từng
// ScheduleId, Lý thuyết/Thực hành tách riêng.
export interface SchedulePeriodProgress {
  scheduleId: number;
  subjectId: number;
  category: "LyThuyet" | "ThucHanh" | null;
  periodsThisSession: number;
  cumulativeTheoryPeriods: number;
  cumulativePracticePeriods: number;
  theoryTarget: number;
  practiceTarget: number;
}

export type ExamType = "TuLuan" | "TracNghiem" | "VanDap" | "ThucHanh";
export type ExamStatus = "ChuaThi" | "DaThi" | "Huy";

export interface ExamItem {
  ExamId: number;
  SemesterId: number;
  ClassId: number;
  ClassName: string;
  SubjectId: number;
  SubjectName: string;
  RoomId: number;
  RoomName: string;
  ExamDate: string;
  StartTime: string;
  EndTime: string;
  ExamType: ExamType;
  Status: ExamStatus;
  Note: string | null;
  Proctors: string | null;
}

export interface BulkImportResult {
  successCount: number;
  errorCount: number;
  errors: { index: number; message: string }[];
  skippedCount?: number;
  skipped?: { index: number; message: string }[];
}

export interface SchedulingPolicyItem {
  PolicyKey: string;
  PolicyValue: string;
  Description: string | null;
}

export interface CopyWeekResult {
  created: number;
  skippedHolidays: number;
  skippedConflicts: string[];
  message?: string;
}

// Tự động xếp Thời khóa biểu (1 Lớp + 1 Kỳ mỗi lần chạy) — kết quả trả về sau khi gọi
// POST /schedule/auto-generate.
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

export interface Account {
  UserId: number;
  Username: string;
  Role: UserRole;
  TeacherId: number | null;
  TeacherName: string | null;
  IsActive: boolean;
  LastLoginAt: string | null;
  CreatedAt: string;
}

export interface NotificationItem {
  NotificationId: number;
  Content: string;
  RelatedType: "Schedule" | "Exam" | null;
  RelatedId: number | null;
  IsRead: boolean;
  CreatedAt: string;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

export interface TeachingHoursReportRow {
  teacherId: number;
  fullName: string;
  totalHours: number;
  maxHours: number;
  percentUsed: number;
  isOverLimit: boolean;
}

export interface ApiErrorResponse {
  message: string;
  conflict?: {
    roomConflicts?: unknown[];
    teacherConflicts?: unknown[];
    proctorConflicts?: unknown[];
    roomUnavailable?: unknown[];
    teacherUnavailable?: unknown[];
  };
}
