import { FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { useAuth } from "../../context/AuthContext";
import { ScheduleItem, ScheduleDetail, SchedulePeriodProgress, Semester, SchoolClass, Subject, Room, Teacher, Session, SchedulingPolicyItem, ApiErrorResponse, CopyWeekResult, CurriculumItem, Cohort, AutoScheduleReport } from "../../types";
import { AxiosError } from "axios";
import { addDays, addMinutesToTime, colorForId, diffMinutesBetweenTimes, findTodayWeekIndex, getISOWeek, getISOWeekYear, getWeeksInSemester, mondayOfISOWeek, parseDateKey, startOfWeek, toDateKey, WEEKDAY_LABELS } from "../../../utils/calendar";
import { buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { subjectLabel } from "../../../utils/text";

interface ScheduleForm {
  semesterId: string;
  classId: string;
  subjectId: string;
  sessionType: string;
  roomId: string;
  teacherIds: string[];
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
}

const emptyForm: ScheduleForm = {
  semesterId: "", classId: "", subjectId: "", sessionType: "", roomId: "",
  teacherIds: [], scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
};

interface MergeForm {
  semesterId: string;
  classIds: string[];
  subjectId: string;
  sessionType: string;
  roomId: string;
  teacherIds: string[];
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
}

const emptyMergeForm: MergeForm = {
  semesterId: "", classIds: [], subjectId: "", sessionType: "", roomId: "",
  teacherIds: [], scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
};

interface GroupRow {
  groupLabel: string;
  roomId: string;
  teacherIds: string[];
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
}

interface GroupForm {
  semesterId: string;
  classId: string;
  subjectId: string;
  sessionType: string;
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
  groups: GroupRow[];
}

const emptyGroupRow: GroupRow = { groupLabel: "", roomId: "", teacherIds: [], scheduleDate: "", sessionId: "", periodCount: "" };
const emptyGroupForm: GroupForm = {
  semesterId: "", classId: "", subjectId: "", sessionType: "", scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
  groups: [{ ...emptyGroupRow, groupLabel: "Nhóm 1" }, { ...emptyGroupRow, groupLabel: "Nhóm 2" }],
};

const CAPACITY_POLICY_BY_ROOM_TYPE: Record<string, string> = {
  LyThuyet: "MaxStudentsPerTheoryRoom",
  ThucHanh: "MaxStudentsPerPracticeGroup",
  LamSang: "MaxStudentsPerClinicalGroup",
};

// Việc AW: ô chọn "Loại buổi học" tường minh thay vì bắt Admin phải đoán qua tên Phòng.
// Việc BA: giá trị lưu trong form.sessionType nay là "Theory"/"Practice" (khớp thẳng
// Schedule.SessionType gửi lên backend) thay vì NHÓM loại phòng như trước — vì 1 buổi Thực hành
// có thể dạy tại phòng Lý thuyết (môn có PracticeMode=LyThuyet), lúc đó "loại phòng" và
// "SessionType" không còn là 1. roomCategoryFor() suy ra nhóm RoomType cần lọc dựa trên CẢ 2:
// PracticeMode của môn đang chọn + SessionType người dùng chọn.
const ROOM_TYPES_BY_CATEGORY: Record<string, string[]> = {
  LyThuyet: ["LyThuyet", "SanBai"],
  ThucHanh: ["ThucHanh", "Labo"],
  LamSang: ["LamSang"],
};

function roomCategoryFor(practiceMode: string | null, sessionType: string): string {
  if (sessionType === "Theory") return "LyThuyet";
  if (sessionType === "Practice") {
    if (practiceMode === "LyThuyet") return "LyThuyet";
    if (practiceMode === "LamSang") return "LamSang";
    return "ThucHanh";
  }
  return "";
}

// Nhãn lựa chọn "Loại buổi học" phụ thuộc Hình thức dạy Thực hành (PracticeMode) của môn đang
// chọn — cùng 2 lựa chọn Lý thuyết/Thực hành nhưng nhãn (và nhóm phòng cho phép) khác nhau.
function sessionTypeOptionsForPracticeMode(practiceMode: string | null): { value: string; label: string }[] {
  if (practiceMode === "LyThuyet") {
    return [
      { value: "Theory", label: "Lý thuyết" },
      { value: "Practice", label: "Thực hành (dạy tại phòng Lý thuyết)" },
    ];
  }
  if (practiceMode === "LamSang") {
    return [
      { value: "Theory", label: "Lý thuyết" },
      { value: "Practice", label: "Lâm sàng" },
    ];
  }
  return [
    { value: "Theory", label: "Lý thuyết" },
    { value: "Practice", label: "Thực hành" },
  ];
}

// Sửa buổi xếp từ trước khi có cột Schedule.SessionType (NULL) — suy luận tạm theo RoomType,
// đồng bộ với fallback ở backend (policyRules.ts).
function inferSessionTypeFromRoomType(roomType: string): string {
  if (roomType === "LyThuyet" || roomType === "SanBai") return "Theory";
  if (roomType === "ThucHanh" || roomType === "Labo" || roomType === "LamSang") return "Practice";
  return "";
}

// Việc AS: độ dài 1 tiết phụ thuộc loại Phòng — Lý thuyết dùng TheoryPeriodMinutes, Thực
// hành/Labo/Lâm sàng dùng PracticePeriodMinutes, Sân bãi mặc định theo giờ Lý thuyết.
function periodMinutesForRoomType(roomType: string, policies: Record<string, number>): number {
  if (roomType === "ThucHanh" || roomType === "Labo" || roomType === "LamSang") {
    return policies.PracticePeriodMinutes ?? 60;
  }
  return policies.TheoryPeriodMinutes ?? 45;
}

interface ComputedEndTimeResult {
  endTime: string | null;
  overflowMessage: string | null;
}

// StartTime luôn neo theo Ca đã chọn; EndTime = StartTime + Số tiết * độ dài 1 tiết (theo loại
// Phòng) — không được vượt quá EndTime gốc của Ca.
function computeEndTime(session: Session | null, room: Room | null, periodCount: string, policies: Record<string, number>): ComputedEndTimeResult {
  if (!session || !room) return { endTime: null, overflowMessage: null };
  const periods = Number(periodCount);
  if (!periods || periods <= 0) return { endTime: null, overflowMessage: null };
  const periodMinutes = periodMinutesForRoomType(room.RoomType, policies);
  const endTime = addMinutesToTime(session.StartTime, periods * periodMinutes);
  if (endTime > session.EndTime) {
    return {
      endTime,
      overflowMessage: `Ca ${session.SessionName} kết thúc lúc ${session.EndTime}, số tiết bạn nhập làm giờ học kết thúc lúc ${endTime} — vượt quá Ca, hãy giảm số tiết hoặc đổi Ca`,
    };
  }
  return { endTime, overflowMessage: null };
}

function fmtDDMM(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtDDMMYYYY(d: Date): string {
  return `${fmtDDMM(d)}/${d.getFullYear()}`;
}

// Việc AT: dropdown chọn môn chỉ hiện đúng những môn đã khai báo trong Khung chương trình
// (CurriculumItems) cho đúng Ngành + đúng Kỳ của Lớp/Đợt học đang chọn — không hiện môn của
// Kỳ khác dù cùng Ngành. Thiếu majorId hoặc termNumber thì coi như chưa lọc được gì.
// Việc BA: đổi từ Set<number> sang Map<number,string> (SubjectId -> PracticeMode) — cần biết
// Hình thức dạy Thực hành của môn đang chọn để quyết định nhãn/nhóm phòng ở "Loại buổi học"
// (.has() vẫn dùng được y hệt Set cho các chỗ chỉ cần kiểm tra môn có thuộc khung chương trình).
async function loadCurriculumSubjectInfo(majorId?: number, termNumber?: number | null, cohortId?: number | null): Promise<Map<number, string>> {
  if (!majorId || !termNumber) return new Map();
  const params: Record<string, string> = { majorId: String(majorId), termNumber: String(termNumber) };
  if (cohortId) params.cohortId = String(cohortId);
  const res = await axiosClient.get<CurriculumItem[]>("/curriculum-items", { params });
  return new Map(res.data.map((ci) => [ci.SubjectId, ci.PracticeMode]));
}

function practiceModeForSubject(info: Map<number, string> | null, subjectId: string): string | null {
  if (!info || !subjectId) return null;
  return info.get(Number(subjectId)) ?? null;
}

function trainingModeLabel(mode: "CQ" | "LT" | null): string {
  if (mode === "CQ") return "Chính quy (CQ)";
  if (mode === "LT") return "Liên thông (LT)";
  return "Chưa xác định hệ đào tạo";
}

function trainingModeHint(mode: "CQ" | "LT" | null): string {
  if (mode === "CQ") return "Chỉ xếp Thứ 2–6, mỗi ngày chỉ 1 buổi (Sáng hoặc Chiều), không học buổi Tối.";
  if (mode === "LT") return "Chỉ xếp Thứ 7/Chủ nhật (cả ngày), hoặc buổi Tối các ngày Thứ 2–6.";
  return "";
}

// Việc AZ: Lớp có thể ghi đè kiểu lịch học riêng (khác Hệ đào tạo thật của Ngành, vd văn bằng 2) —
// hiện rõ NGAY khi có ghi đè để Admin không nhầm tưởng lịch phải theo đúng Hệ gốc của Ngành.
function classScheduleModeEffective(cls: SchoolClass): "CQ" | "LT" | null {
  return cls.SchedulePatternOverride || cls.TrainingMode;
}

function ClassScheduleModeHint({ cls }: { cls: SchoolClass }) {
  const effective = classScheduleModeEffective(cls);
  if (cls.SchedulePatternOverride) {
    return (
      <>
        Kiểu lịch học: <b>{trainingModeLabel(cls.SchedulePatternOverride)}</b> (ghi đè riêng, Ngành gốc là {trainingModeLabel(cls.TrainingMode)}) — {trainingModeHint(effective)}
      </>
    );
  }
  return (
    <>Hệ đào tạo: <b>{trainingModeLabel(cls.TrainingMode)}</b> — {trainingModeHint(cls.TrainingMode)}</>
  );
}

// Gộp các buổi cùng MergedSessionId (ghép lớp) thành 1 nhóm hiển thị chung;
// các buổi không ghép lớp giữ nguyên từng nhóm riêng lẻ.
interface EventGroup { key: string; events: ScheduleItem[]; isMerged: boolean }

function groupMergedEvents(events: ScheduleItem[]): EventGroup[] {
  const groups: EventGroup[] = [];
  const mergedSeen = new Set<number>();
  for (const ev of events) {
    if (ev.MergedSessionId != null) {
      if (mergedSeen.has(ev.MergedSessionId)) continue;
      mergedSeen.add(ev.MergedSessionId);
      const siblings = events.filter((e) => e.MergedSessionId === ev.MergedSessionId);
      groups.push({ key: `merged-${ev.MergedSessionId}`, events: siblings, isMerged: true });
    } else {
      groups.push({ key: `single-${ev.ScheduleId}`, events: [ev], isMerged: false });
    }
  }
  return groups;
}

// Nội dung bên trong 1 thẻ buổi học — dùng chung cho cả chế độ "Theo lớp" và "Tất cả các lớp" để
// 2 chế độ luôn hiện ĐẦY ĐỦ cùng 1 loại thông tin (Môn/Lớp/Phòng/GV/tiến độ số tiết), không lệch nhau.
function EventCardContent({ ev, g, progress }: { ev: ScheduleItem; g: EventGroup; progress?: SchedulePeriodProgress }) {
  const classNames = g.events.map((e) => e.ClassName).join(", ");
  return (
    <>
      <div className="calendar-event-title">
        {g.isMerged && <span title="Buổi ghép lớp">🔗 </span>}{ev.SubjectName}
        {ev.GroupLabel && <span title="Buổi tách nhóm"> · {ev.GroupLabel}</span>}
      </div>
      <div className="calendar-event-sub">{classNames} · {ev.RoomName}</div>
      {ev.Teachers && <div className="calendar-event-sub">{ev.Teachers}</div>}
      {progress && (
        <>
          <div className="calendar-event-sub">Số tiết buổi này: {progress.periodsThisSession} tiết</div>
          {progress.theoryTarget > 0 && (
            <div className="calendar-event-sub">Lý thuyết: {progress.cumulativeTheoryPeriods}/{progress.theoryTarget} tiết</div>
          )}
          {progress.practiceTarget > 0 && (
            <div className="calendar-event-sub">Thực hành: {progress.cumulativePracticePeriods}/{progress.practiceTarget} tiết</div>
          )}
        </>
      )}
    </>
  );
}

export default function ScheduleGrid() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<ScheduleItem[]>([]);
  // Việc AU (fix): key theo ScheduleId (không phải SubjectId) — mỗi buổi có tiến độ lũy kế RIÊNG
  // theo đúng thứ tự thời gian của nó, không dùng chung 1 tổng cho mọi buổi cùng môn.
  const [periodProgress, setPeriodProgress] = useState<Record<number, SchedulePeriodProgress>>({});
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filters, setFilters] = useState({ semesterId: "", classId: "" });
  const [form, setForm] = useState<ScheduleForm>(emptyForm);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  // Việc AU: Sửa 1 buổi đã xếp — dùng lại chính form "Xếp buổi học mới", chỉ khóa Lớp/Đợt
  // học/Môn học (không cho đổi sang buổi khác) và hiện tiến độ số tiết đã xếp/tổng số tiết môn.
  const [editingScheduleId, setEditingScheduleId] = useState<number | null>(null);
  const [editProgress, setEditProgress] = useState<{
    theoryTarget: number; practiceTarget: number; cumulativeTheoryPeriods: number; cumulativePracticePeriods: number;
  } | null>(null);

  const [mergeForm, setMergeForm] = useState<MergeForm>(emptyMergeForm);
  const [mergeError, setMergeError] = useState("");
  const [showMergeForm, setShowMergeForm] = useState(false);

  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm);
  const [groupError, setGroupError] = useState("");
  const [showGroupForm, setShowGroupForm] = useState(false);

  const [policies, setPolicies] = useState<Record<string, number>>({});

  const [formSemesters, setFormSemesters] = useState<Semester[]>([]);
  const [mergeSemesters, setMergeSemesters] = useState<Semester[]>([]);
  const [groupSemesters, setGroupSemesters] = useState<Semester[]>([]);

  const [showCopyWeekForm, setShowCopyWeekForm] = useState(false);
  const [copyWeekTargetIndex, setCopyWeekTargetIndex] = useState("");
  const [copyWeekError, setCopyWeekError] = useState("");

  // Tự động xếp Thời khóa biểu (1 Lớp + 1 Kỳ đang chọn ở bộ lọc trên cùng).
  const [autoScheduling, setAutoScheduling] = useState(false);
  const [autoScheduleReport, setAutoScheduleReport] = useState<AutoScheduleReport | null>(null);
  const [autoScheduleError, setAutoScheduleError] = useState("");

  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);

  // Việc AU: chế độ xem "Tất cả các lớp" — bảng tổng hợp toàn trường theo TUẦN LỊCH THẬT (không
  // theo Tuần N của 1 Kỳ, vì mỗi lớp trong cùng Khóa có thể đang ở Kỳ khác nhau).
  const [viewMode, setViewMode] = useState<"byClass" | "allClasses">("byClass");
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [allClassesCohortId, setAllClassesCohortId] = useState("");
  const [allClassesTrainingMode, setAllClassesTrainingMode] = useState("");
  const [allClassesWeekStart, setAllClassesWeekStart] = useState(() => startOfWeek(new Date()));
  const [allClassesRows, setAllClassesRows] = useState<ScheduleItem[]>([]);
  const [allClassesPeriodProgress, setAllClassesPeriodProgress] = useState<Record<number, SchedulePeriodProgress>>({});

  const selectedSemester = useMemo(
    () => semesters.find((s) => String(s.SemesterId) === filters.semesterId) || null,
    [semesters, filters.semesterId]
  );

  const semesterWeeks = useMemo(
    () => (selectedSemester ? getWeeksInSemester(selectedSemester.StartDate, selectedSemester.EndDate) : []),
    [selectedSemester]
  );

  // Khi đổi kỳ: mặc định chọn tuần chứa hôm nay nếu hôm nay nằm trong kỳ, ngược lại Tuần 1.
  useEffect(() => {
    if (semesterWeeks.length === 0) {
      setSelectedWeekIndex(0);
      return;
    }
    const todayIdx = findTodayWeekIndex(semesterWeeks);
    setSelectedWeekIndex(todayIdx >= 0 ? todayIdx : 0);
  }, [selectedSemester?.SemesterId]);

  const currentWeek = semesterWeeks[selectedWeekIndex] || null;

  const selectedFormClass = useMemo(
    () => classes.find((c) => String(c.ClassId) === form.classId) || null,
    [classes, form.classId]
  );

  const selectedMergeClasses = useMemo(
    () => classes.filter((c) => mergeForm.classIds.includes(String(c.ClassId))),
    [classes, mergeForm.classIds]
  );

  const selectedGroupClass = useMemo(
    () => classes.find((c) => String(c.ClassId) === groupForm.classId) || null,
    [classes, groupForm.classId]
  );

  const selectedFormSemester = useMemo(
    () => formSemesters.find((s) => String(s.SemesterId) === form.semesterId) || null,
    [formSemesters, form.semesterId]
  );
  const selectedMergeSemester = useMemo(
    () => mergeSemesters.find((s) => String(s.SemesterId) === mergeForm.semesterId) || null,
    [mergeSemesters, mergeForm.semesterId]
  );
  const selectedGroupSemester = useMemo(
    () => groupSemesters.find((s) => String(s.SemesterId) === groupForm.semesterId) || null,
    [groupSemesters, groupForm.semesterId]
  );

  // Việc AT: dropdown chọn môn chỉ hiện đúng những môn đã khai báo trong Khung chương trình
  // (CurriculumItems) cho đúng Ngành CỦA LỚP + đúng Kỳ CỦA ĐỢT HỌC đang chọn — chặt hơn Việc AR
  // (vốn chỉ lọc theo Ngành, không phân biệt Kỳ). Chưa đủ Lớp + Kỳ thì coi như chưa có môn nào.
  const [formCurriculumSubjectInfo, setFormCurriculumSubjectInfo] = useState<Map<number, string> | null>(null);
  const [mergeCurriculumSubjectInfo, setMergeCurriculumSubjectInfo] = useState<Map<number, string> | null>(null);
  const [groupCurriculumSubjectInfo, setGroupCurriculumSubjectInfo] = useState<Map<number, string> | null>(null);
  // Việc BA: khi Sửa 1 buổi đã xếp, PracticeMode của môn được nạp riêng (không dùng chung
  // formCurriculumSubjectInfo, vốn phụ thuộc form.semesterId — bị bỏ trống lúc Sửa) để tránh bị
  // effect bên dưới ghi đè lại thành null ngay sau khi mở form Sửa.
  const [editSubjectPracticeMode, setEditSubjectPracticeMode] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedFormClass || !selectedFormSemester) { setFormCurriculumSubjectInfo(null); return; }
    loadCurriculumSubjectInfo(selectedFormClass.MajorId, selectedFormSemester.TermNumber, selectedFormClass.CohortId)
      .then(setFormCurriculumSubjectInfo);
  }, [selectedFormClass?.MajorId, selectedFormClass?.CohortId, selectedFormSemester?.TermNumber]);

  useEffect(() => {
    const first = selectedMergeClasses[0] || null;
    if (!first || !selectedMergeSemester) { setMergeCurriculumSubjectInfo(null); return; }
    loadCurriculumSubjectInfo(first.MajorId, selectedMergeSemester.TermNumber, first.CohortId)
      .then(setMergeCurriculumSubjectInfo);
  }, [selectedMergeClasses[0]?.MajorId, selectedMergeClasses[0]?.CohortId, selectedMergeSemester?.TermNumber]);

  useEffect(() => {
    if (!selectedGroupClass || !selectedGroupSemester) { setGroupCurriculumSubjectInfo(null); return; }
    loadCurriculumSubjectInfo(selectedGroupClass.MajorId, selectedGroupSemester.TermNumber, selectedGroupClass.CohortId)
      .then(setGroupCurriculumSubjectInfo);
  }, [selectedGroupClass?.MajorId, selectedGroupClass?.CohortId, selectedGroupSemester?.TermNumber]);

  const formSubjects = useMemo(
    () => (formCurriculumSubjectInfo ? subjects.filter((s) => formCurriculumSubjectInfo.has(s.SubjectId)) : []),
    [subjects, formCurriculumSubjectInfo]
  );
  const mergeSubjects = useMemo(
    () => (mergeCurriculumSubjectInfo ? subjects.filter((s) => mergeCurriculumSubjectInfo.has(s.SubjectId)) : []),
    [subjects, mergeCurriculumSubjectInfo]
  );
  const groupSubjects = useMemo(
    () => (groupCurriculumSubjectInfo ? subjects.filter((s) => groupCurriculumSubjectInfo.has(s.SubjectId)) : []),
    [subjects, groupCurriculumSubjectInfo]
  );

  // Việc BA: PracticeMode của môn đang chọn — quyết định nhãn "Loại buổi học" và nhóm phòng được
  // phép chọn (roomCategoryFor). Ở form thường, ưu tiên editSubjectPracticeMode khi đang Sửa.
  const formPracticeMode = useMemo(
    () => (editingScheduleId ? editSubjectPracticeMode : practiceModeForSubject(formCurriculumSubjectInfo, form.subjectId)),
    [editingScheduleId, editSubjectPracticeMode, formCurriculumSubjectInfo, form.subjectId]
  );
  const mergePracticeMode = useMemo(
    () => practiceModeForSubject(mergeCurriculumSubjectInfo, mergeForm.subjectId),
    [mergeCurriculumSubjectInfo, mergeForm.subjectId]
  );
  const groupPracticeMode = useMemo(
    () => practiceModeForSubject(groupCurriculumSubjectInfo, groupForm.subjectId),
    [groupCurriculumSubjectInfo, groupForm.subjectId]
  );

  // Việc AS: tính EndTime theo Số tiết thực tế thay vì lấp đầy cả Ca — mỗi form tra Phòng/Ca
  // đang chọn của chính nó (form tách nhóm dùng Phòng của Nhóm 1 làm đại diện, giống cách
  // scheduleController tính sessionLengthCheck ở backend).
  const formRoom = useMemo(() => rooms.find((r) => String(r.RoomId) === form.roomId) || null, [rooms, form.roomId]);
  const formSession = useMemo(() => sessions.find((s) => s.SessionId === Number(form.sessionId)) || null, [sessions, form.sessionId]);
  const formEndTimeResult = useMemo(
    () => computeEndTime(formSession, formRoom, form.periodCount, policies),
    [formSession, formRoom, form.periodCount, policies]
  );

  const mergeRoom = useMemo(() => rooms.find((r) => String(r.RoomId) === mergeForm.roomId) || null, [rooms, mergeForm.roomId]);
  const mergeSession = useMemo(() => sessions.find((s) => s.SessionId === Number(mergeForm.sessionId)) || null, [sessions, mergeForm.sessionId]);
  const mergeEndTimeResult = useMemo(
    () => computeEndTime(mergeSession, mergeRoom, mergeForm.periodCount, policies),
    [mergeSession, mergeRoom, mergeForm.periodCount, policies]
  );

  // Việc AY: mỗi nhóm tự chọn Ngày/Ca/Số tiết riêng (để xoay vòng dùng chung 1 phòng khác giờ nhau)
  // — tính EndTime ĐỘC LẬP cho từng nhóm, không còn dùng chung 1 kết quả đại diện như trước.
  const groupRowsComputed = useMemo(
    () => groupForm.groups.map((g) => {
      const room = rooms.find((r) => String(r.RoomId) === g.roomId) || null;
      const session = sessions.find((s) => s.SessionId === Number(g.sessionId)) || null;
      return { room, session, endTimeResult: computeEndTime(session, room, g.periodCount, policies) };
    }),
    [groupForm.groups, rooms, sessions, policies]
  );

  // Việc AW/BA: dropdown Phòng chỉ hiện phòng thuộc đúng nhóm RoomType tương ứng — nhóm này nay
  // phụ thuộc CẢ PracticeMode của môn lẫn SessionType đã chọn (roomCategoryFor), không chỉ suy
  // thẳng từ SessionType như trước.
  const formRoomsForType = useMemo(
    () => rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[roomCategoryFor(formPracticeMode, form.sessionType)]?.includes(r.RoomType)),
    [rooms, formPracticeMode, form.sessionType]
  );
  const mergeRoomsForType = useMemo(
    () => rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[roomCategoryFor(mergePracticeMode, mergeForm.sessionType)]?.includes(r.RoomType)),
    [rooms, mergePracticeMode, mergeForm.sessionType]
  );
  const groupRoomsForType = useMemo(
    () => rooms.filter((r) => ROOM_TYPES_BY_CATEGORY[roomCategoryFor(groupPracticeMode, groupForm.sessionType)]?.includes(r.RoomType)),
    [rooms, groupPracticeMode, groupForm.sessionType]
  );

  // Gợi ý tách nhóm: sĩ số lớp vượt giới hạn/ca của loại phòng đang chọn ở form xếp lịch thường.
  const capacityHint = useMemo(() => {
    if (!selectedFormClass || !form.roomId) return null;
    const room = rooms.find((r) => String(r.RoomId) === form.roomId);
    if (!room) return null;
    const policyKey = CAPACITY_POLICY_BY_ROOM_TYPE[room.RoomType];
    if (!policyKey || !(policyKey in policies)) return null;
    const max = policies[policyKey];
    if (selectedFormClass.ClassSize <= max) return null;
    return `Lớp ${selectedFormClass.ClassName} có ${selectedFormClass.ClassSize} người, vượt giới hạn ${max} người/ca của loại phòng này — dùng "Xếp theo nhóm" để tách nhóm học song song.`;
  }, [selectedFormClass, form.roomId, rooms, policies]);

  async function loadLookups() {
    const [cls, subj, room, tch, ses, policy, coh] = await Promise.all([
      axiosClient.get<SchoolClass[]>("/classes"),
      axiosClient.get<Subject[]>("/subjects", { params: { isActive: true } }),
      axiosClient.get<Room[]>("/rooms"),
      axiosClient.get<Teacher[]>("/teachers"),
      axiosClient.get<Session[]>("/sessions"),
      axiosClient.get<SchedulingPolicyItem[]>("/scheduling-policy"),
      axiosClient.get<Cohort[]>("/cohorts"),
    ]);
    setClasses(cls.data); setSubjects(subj.data);
    setRooms(room.data); setTeachers(tch.data);
    setSessions(ses.data.sort((a, b) => a.SortOrder - b.SortOrder));
    setPolicies(Object.fromEntries(policy.data.map((p) => [p.PolicyKey, Number(p.PolicyValue)])));
    setCohorts(coh.data);
  }

  // Mỗi Lớp có bộ Kỳ học riêng — không còn danh sách Đợt học chung, phải nạp lại theo đúng
  // classId đang chọn ở từng nơi (bộ lọc trên cùng, và riêng từng form tạo lịch).
  async function loadSemestersFor(classId: string): Promise<Semester[]> {
    if (!classId) return [];
    const res = await axiosClient.get<Semester[]>("/semesters", { params: { classId } });
    return res.data;
  }

  async function loadSchedule() {
    const params: Record<string, string> = {};
    if (filters.semesterId) params.semesterId = filters.semesterId;
    if (filters.classId) params.classId = filters.classId;
    const res = await axiosClient.get<ScheduleItem[]>("/schedule", { params });
    setRows(res.data);

    // Việc AU: tiến độ số tiết lũy kế RIÊNG cho từng buổi, hiện ngay trên từng thẻ buổi học —
    // nạp lại cùng lúc với lịch để luôn khớp dữ liệu mới nhất sau khi thêm/sửa/xóa buổi.
    if (filters.classId) {
      const progressRes = await axiosClient.get<SchedulePeriodProgress[]>(
        "/schedule/period-progress", { params: { classId: filters.classId } }
      );
      setPeriodProgress(Object.fromEntries(progressRes.data.map((p) => [p.scheduleId, p])));
    } else {
      setPeriodProgress({});
    }
  }

  useEffect(() => { loadLookups(); }, []);
  useEffect(() => { loadSchedule(); }, [filters]);
  useEffect(() => { loadSemestersFor(filters.classId).then(setSemesters); }, [filters.classId]);
  useEffect(() => { loadSemestersFor(form.classId).then(setFormSemesters); }, [form.classId]);
  useEffect(() => { loadSemestersFor(mergeForm.classIds[0] || "").then(setMergeSemesters); }, [mergeForm.classIds[0]]);
  useEffect(() => { loadSemestersFor(groupForm.classId).then(setGroupSemesters); }, [groupForm.classId]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, ScheduleItem[]> = {};
    for (const r of rows) {
      const key = r.ScheduleDate?.slice(0, 10);
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => a.StartTime.localeCompare(b.StartTime));
    }
    return map;
  }, [rows]);

  const weekDays = useMemo(() => {
    if (!currentWeek) return [];
    return Array.from({ length: 7 }, (_, i) => addDays(currentWeek.start, i));
  }, [currentWeek]);

  interface DayGrid { bySession: Map<number, ScheduleItem[]>; leftover: ScheduleItem[] }

  const weekDayGrids = useMemo(() => {
    const map: Record<string, DayGrid> = {};
    for (const day of weekDays) {
      const key = toDateKey(day);
      const dayEvents = eventsByDate[key] || [];
      const bySession = new Map<number, ScheduleItem[]>();
      const leftover: ScheduleItem[] = [];
      for (const ev of dayEvents) {
        const session = sessions.find((s) => s.StartTime < ev.EndTime && s.EndTime > ev.StartTime);
        if (!session) {
          leftover.push(ev);
          continue;
        }
        const existing = bySession.get(session.SessionId);
        if (existing) existing.push(ev);
        else bySession.set(session.SessionId, [ev]);
      }
      map[key] = { bySession, leftover };
    }
    return map;
  }, [weekDays, eventsByDate, sessions]);

  // Việc AU: chế độ xem "Tất cả các lớp" — cột = từng Lớp thuộc Khóa đang chọn (lọc thêm Hệ đào
  // tạo nếu có), hàng = Thứ x Buổi trong TUẦN LỊCH THẬT đang xem (không phụ thuộc Kỳ của lớp nào).
  const allClassesDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(allClassesWeekStart, i)),
    [allClassesWeekStart]
  );

  const visibleAllClasses = useMemo(() => {
    if (!allClassesCohortId) return [];
    return classes
      .filter((c) => c.IsActive && String(c.CohortId) === allClassesCohortId
        && (!allClassesTrainingMode || c.TrainingMode === allClassesTrainingMode))
      .sort((a, b) => a.ClassName.localeCompare(b.ClassName));
  }, [classes, allClassesCohortId, allClassesTrainingMode]);

  async function loadAllClassesSchedule() {
    if (!allClassesCohortId) {
      setAllClassesRows([]);
      setAllClassesPeriodProgress({});
      return;
    }
    const from = toDateKey(allClassesWeekStart);
    const to = toDateKey(addDays(allClassesWeekStart, 6));
    const [scheduleRes, progressRes] = await Promise.all([
      axiosClient.get<ScheduleItem[]>("/schedule", { params: { cohortId: allClassesCohortId, from, to } }),
      axiosClient.get<SchedulePeriodProgress[]>("/schedule/period-progress", { params: { cohortId: allClassesCohortId } }),
    ]);
    setAllClassesRows(scheduleRes.data);
    setAllClassesPeriodProgress(Object.fromEntries(progressRes.data.map((p) => [p.scheduleId, p])));
  }
  useEffect(() => {
    if (viewMode === "allClasses") loadAllClassesSchedule();
  }, [viewMode, allClassesCohortId, allClassesWeekStart]);

  // classId -> ngày (YYYY-MM-DD) -> SessionId -> các buổi khớp đúng ngày+ca đó.
  const allClassesGrid = useMemo(() => {
    const map = new Map<number, Map<string, Map<number, ScheduleItem[]>>>();
    for (const ev of allClassesRows) {
      const dateKey = ev.ScheduleDate.slice(0, 10);
      const session = sessions.find((s) => s.StartTime < ev.EndTime && s.EndTime > ev.StartTime);
      if (!session) continue;
      if (!map.has(ev.ClassId)) map.set(ev.ClassId, new Map());
      const byDate = map.get(ev.ClassId)!;
      if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
      const bySession = byDate.get(dateKey)!;
      if (!bySession.has(session.SessionId)) bySession.set(session.SessionId, []);
      bySession.get(session.SessionId)!.push(ev);
    }
    return map;
  }, [allClassesRows, sessions]);

  // Ẩn bớt Thứ không có buổi nào của các lớp đang hiện (thường là Chủ nhật) — nhưng nếu cả tuần
  // trống trơn thì vẫn hiện đủ 7 ngày để không làm bảng biến mất hoàn toàn, gây hiểu lầm là lỗi.
  const allClassesVisibleDays = useMemo(() => {
    if (allClassesRows.length === 0) return allClassesDays;
    const visibleClassIds = new Set(visibleAllClasses.map((c) => c.ClassId));
    const filtered = allClassesDays.filter((day) => {
      const key = toDateKey(day);
      return allClassesRows.some((ev) => visibleClassIds.has(ev.ClassId) && ev.ScheduleDate.slice(0, 10) === key);
    });
    return filtered.length > 0 ? filtered : allClassesDays;
  }, [allClassesDays, allClassesRows, visibleAllClasses]);

  // Nhảy thẳng tới 1 tuần bất kỳ qua chọn Năm + Tuần (ISO) — bấm lùi/tới từng tuần vẫn còn để
  // tinh chỉnh, nhưng chọn thẳng nhanh hơn nhiều khi cần nhảy xa (vd sang kỳ/năm học khác).
  const allClassesSelectedYear = getISOWeekYear(allClassesWeekStart);
  const allClassesSelectedWeek = getISOWeek(allClassesWeekStart);
  const allClassesYearOptions = useMemo(() => {
    const thisYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => thisYear - 1 + i);
  }, []);

  function goCurrentWeek() {
    const todayIdx = findTodayWeekIndex(semesterWeeks);
    if (todayIdx >= 0) setSelectedWeekIndex(todayIdx);
  }
  function goPrevWeek() {
    setSelectedWeekIndex((i) => Math.max(0, i - 1));
  }
  function goNextWeek() {
    setSelectedWeekIndex((i) => Math.min(semesterWeeks.length - 1, i + 1));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const session = sessions.find((s) => s.SessionId === Number(form.sessionId));
    if (!session) {
      setError("Vui lòng chọn ca học");
      return;
    }
    if (!formRoom) {
      setError("Vui lòng chọn phòng học");
      return;
    }
    if (!form.periodCount || Number(form.periodCount) <= 0) {
      setError("Vui lòng nhập số tiết");
      return;
    }
    if (!formEndTimeResult.endTime || formEndTimeResult.overflowMessage) {
      setError(formEndTimeResult.overflowMessage || "Không tính được giờ kết thúc");
      return;
    }

    const payload = {
      semesterId: Number(form.semesterId),
      classId: Number(form.classId),
      subjectId: Number(form.subjectId),
      roomId: Number(form.roomId),
      teacherIds: form.teacherIds.map(Number),
      scheduleDate: form.scheduleDate,
      startTime: session.StartTime,
      endTime: formEndTimeResult.endTime,
      note: form.note,
      isMakeup: form.isMakeup,
      sessionType: form.sessionType,
    };
    try {
      const res = editingScheduleId
        ? await axiosClient.put<{ warning?: string }>(`/schedule/${editingScheduleId}`, payload)
        : await axiosClient.post<{ warning?: string }>("/schedule", payload);
      if (res.data.warning) alert(res.data.warning);
      handleCancelEdit();
      loadSchedule();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      const conflict = axiosErr.response?.data?.conflict;
      let msg = axiosErr.response?.data?.message || "Có lỗi xảy ra";
      if (conflict?.roomConflicts?.length) msg += ` — Trùng phòng ${conflict.roomConflicts.length} lần`;
      if (conflict?.teacherConflicts?.length) msg += ` — Trùng giảng viên ${conflict.teacherConflicts.length} lần`;
      setError(msg);
    }
  }

  function handleCancelEdit() {
    setEditingScheduleId(null);
    setEditProgress(null);
    setEditSubjectPracticeMode(null);
    setForm(emptyForm);
    setShowForm(false);
    setError("");
  }

  // Chỉ dọn trạng thái Sửa (không đụng tới form nếu đang KHÔNG sửa) — dùng khi chuyển sang tab
  // Ghép lớp/Tách nhóm để tránh mở nhầm form Sửa còn treo, mà không xóa nhầm nháp form thường.
  function clearEditingIfActive() {
    if (!editingScheduleId) return;
    setEditingScheduleId(null);
    setEditProgress(null);
    setEditSubjectPracticeMode(null);
    setForm(emptyForm);
  }

  // Việc AU: mở form Sửa cho 1 buổi đã xếp — nạp chi tiết (kèm GV đang dạy thật, không chỉ tên
  // gộp chuỗi) và suy ra lại Ca/Số tiết từ StartTime/EndTime đã lưu để hiện đúng trên form.
  async function handleOpenEdit(scheduleId: number) {
    setShowMergeForm(false);
    setShowGroupForm(false);
    setError("");
    const res = await axiosClient.get<ScheduleDetail>(`/schedule/${scheduleId}`);
    const detail = res.data;
    const session = sessions.find((s) => detail.StartTime >= s.StartTime && detail.StartTime < s.EndTime) || null;
    const periodMinutes = periodMinutesForRoomType(detail.RoomType, policies);
    const periods = Math.round(diffMinutesBetweenTimes(detail.StartTime, detail.EndTime) / periodMinutes);
    const curriculumInfo = await loadCurriculumSubjectInfo(detail.MajorId, detail.TermNumber, detail.CohortId);
    setEditSubjectPracticeMode(curriculumInfo.get(detail.SubjectId) ?? "ThucHanh");
    setForm({
      semesterId: "",
      classId: String(detail.ClassId),
      subjectId: String(detail.SubjectId),
      sessionType: detail.SessionType || inferSessionTypeFromRoomType(detail.RoomType),
      roomId: String(detail.RoomId),
      teacherIds: detail.teacherIds.map(String),
      scheduleDate: detail.ScheduleDate.slice(0, 10),
      sessionId: session ? String(session.SessionId) : "",
      periodCount: periods > 0 ? String(periods) : "",
      note: detail.Note || "",
      isMakeup: false,
    });
    setEditProgress({
      theoryTarget: detail.theoryTarget, practiceTarget: detail.practiceTarget,
      cumulativeTheoryPeriods: detail.cumulativeTheoryPeriods, cumulativePracticePeriods: detail.cumulativePracticePeriods,
    });
    setEditingScheduleId(scheduleId);
    setShowForm(true);
  }

  async function handleMergeSubmit(e: FormEvent) {
    e.preventDefault();
    setMergeError("");

    const session = sessions.find((s) => s.SessionId === Number(mergeForm.sessionId));
    if (!session) {
      setMergeError("Vui lòng chọn ca học");
      return;
    }
    if (mergeForm.classIds.length < 2) {
      setMergeError("Cần chọn ít nhất 2 lớp để ghép");
      return;
    }
    if (!mergeRoom) {
      setMergeError("Vui lòng chọn phòng học");
      return;
    }
    if (!mergeForm.periodCount || Number(mergeForm.periodCount) <= 0) {
      setMergeError("Vui lòng nhập số tiết");
      return;
    }
    if (!mergeEndTimeResult.endTime || mergeEndTimeResult.overflowMessage) {
      setMergeError(mergeEndTimeResult.overflowMessage || "Không tính được giờ kết thúc");
      return;
    }

    const payload = {
      semesterId: Number(mergeForm.semesterId),
      classIds: mergeForm.classIds.map(Number),
      subjectId: Number(mergeForm.subjectId),
      roomId: Number(mergeForm.roomId),
      teacherIds: mergeForm.teacherIds.map(Number),
      scheduleDate: mergeForm.scheduleDate,
      startTime: session.StartTime,
      endTime: mergeEndTimeResult.endTime,
      note: mergeForm.note,
      isMakeup: mergeForm.isMakeup,
      sessionType: mergeForm.sessionType,
    };
    try {
      const res = await axiosClient.post<{ warning?: string }>("/schedule/merged", payload);
      if (res.data.warning) alert(res.data.warning);
      setMergeForm(emptyMergeForm);
      setShowMergeForm(false);
      loadSchedule();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      const conflict = axiosErr.response?.data?.conflict;
      let msg = axiosErr.response?.data?.message || "Có lỗi xảy ra";
      if (conflict?.roomConflicts?.length) msg += ` — Trùng phòng ${conflict.roomConflicts.length} lần`;
      if (conflict?.teacherConflicts?.length) msg += ` — Trùng giảng viên ${conflict.teacherConflicts.length} lần`;
      setMergeError(msg);
    }
  }

  // Việc AY: nhóm mới copy Ngày/Ca/Số tiết từ nhóm liền trước (hoặc từ form chung nếu chưa có
  // nhóm nào) làm giá trị khởi tạo — tiện khi nhiều nhóm dùng chung giờ, nhưng vẫn sửa riêng được.
  function addGroupRow() {
    const last = groupForm.groups[groupForm.groups.length - 1];
    setGroupForm({
      ...groupForm,
      groups: [...groupForm.groups, {
        ...emptyGroupRow,
        groupLabel: `Nhóm ${groupForm.groups.length + 1}`,
        scheduleDate: last?.scheduleDate || groupForm.scheduleDate,
        sessionId: last?.sessionId || groupForm.sessionId,
        periodCount: last?.periodCount || groupForm.periodCount,
      }],
    });
  }

  function removeGroupRow(index: number) {
    if (groupForm.groups.length <= 2) return;
    setGroupForm({ ...groupForm, groups: groupForm.groups.filter((_, i) => i !== index) });
  }

  function updateGroupRow(index: number, patch: Partial<GroupRow>) {
    setGroupForm({
      ...groupForm,
      groups: groupForm.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)),
    });
  }

  async function handleGroupSubmit(e: FormEvent) {
    e.preventDefault();
    setGroupError("");

    if (groupForm.groups.some((g) => !g.groupLabel.trim() || !g.roomId || !g.scheduleDate || !g.sessionId || !g.periodCount)) {
      setGroupError("Mỗi nhóm cần có đủ Tên nhóm, Ngày, Ca, Số tiết và Phòng học");
      return;
    }

    // Việc AY: mỗi nhóm tự tính StartTime/EndTime riêng theo đúng Ngày/Ca/Số tiết của chính nó.
    const groupsPayload: { groupLabel: string; roomId: number; teacherIds: number[]; scheduleDate: string; startTime: string; endTime: string }[] = [];
    for (const g of groupForm.groups) {
      const session = sessions.find((s) => s.SessionId === Number(g.sessionId));
      if (!session) {
        setGroupError(`Nhóm "${g.groupLabel}": vui lòng chọn ca học`);
        return;
      }
      const room = rooms.find((r) => String(r.RoomId) === g.roomId);
      if (!room) {
        setGroupError(`Nhóm "${g.groupLabel}": vui lòng chọn phòng học`);
        return;
      }
      const endTimeResult = computeEndTime(session, room, g.periodCount, policies);
      if (!endTimeResult.endTime || endTimeResult.overflowMessage) {
        setGroupError(`Nhóm "${g.groupLabel}": ${endTimeResult.overflowMessage || "Không tính được giờ kết thúc"}`);
        return;
      }
      groupsPayload.push({
        groupLabel: g.groupLabel.trim(),
        roomId: Number(g.roomId),
        teacherIds: g.teacherIds.map(Number),
        scheduleDate: g.scheduleDate,
        startTime: session.StartTime,
        endTime: endTimeResult.endTime,
      });
    }

    const payload = {
      semesterId: Number(groupForm.semesterId),
      classId: Number(groupForm.classId),
      subjectId: Number(groupForm.subjectId),
      note: groupForm.note,
      isMakeup: groupForm.isMakeup,
      sessionType: groupForm.sessionType,
      groups: groupsPayload,
    };
    try {
      const res = await axiosClient.post<{ warning?: string }>("/schedule/grouped", payload);
      if (res.data.warning) alert(res.data.warning);
      setGroupForm(emptyGroupForm);
      setShowGroupForm(false);
      loadSchedule();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      const conflict = axiosErr.response?.data?.conflict;
      let msg = axiosErr.response?.data?.message || "Có lỗi xảy ra";
      if (conflict?.roomConflicts?.length) msg += ` — Trùng phòng ${conflict.roomConflicts.length} lần`;
      if (conflict?.teacherConflicts?.length) msg += ` — Trùng giảng viên ${conflict.teacherConflicts.length} lần`;
      setGroupError(msg);
    }
  }

  async function handleCopyWeek(e: FormEvent) {
    e.preventDefault();
    setCopyWeekError("");

    const classId = filters.classId;
    if (!classId) {
      setCopyWeekError("Vui lòng chọn lớp cần sao chép lịch");
      return;
    }
    const targetWeek = semesterWeeks[Number(copyWeekTargetIndex)];
    if (!currentWeek || !targetWeek) {
      setCopyWeekError("Vui lòng chọn tuần đích");
      return;
    }
    if (Number(copyWeekTargetIndex) === selectedWeekIndex) {
      setCopyWeekError("Tuần đích phải khác tuần đang xem");
      return;
    }

    const sourceWeekStart = toDateKey(currentWeek.start);
    const targetWeekStart = toDateKey(targetWeek.start);

    try {
      const res = await axiosClient.post<CopyWeekResult>("/schedule/copy-week", {
        classId: Number(classId), sourceWeekStart, targetWeekStart,
      });
      const { created, skippedHolidays, skippedConflicts } = res.data;
      let msg = `Đã sao chép ${created} tiết`;
      if (skippedHolidays > 0) msg += `, bỏ qua ${skippedHolidays} tiết do trùng nghỉ lễ`;
      if (skippedConflicts.length > 0) {
        msg += `, bỏ qua ${skippedConflicts.length} tiết do xung đột:\n- ${skippedConflicts.join("\n- ")}`;
      }
      alert(msg);
      setShowCopyWeekForm(false);
      loadSchedule();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setCopyWeekError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  // Tự động xếp lịch CHỈ trong đúng Tuần đang xem (không động tới tuần khác) — dùng đúng weekNumber
  // của currentWeek, khớp với cách đánh số Tuần 1..N của chế độ xem "Theo kỳ" hiện có.
  async function handleAutoSchedule() {
    if (!filters.classId || !filters.semesterId || !currentWeek) return;
    if (!confirm(`Tự động xếp lịch cho Tuần ${currentWeek.weekNumber} của Lớp + Kỳ đang chọn?`)) return;
    setAutoScheduleError("");
    setAutoScheduleReport(null);
    setAutoScheduling(true);
    try {
      const res = await axiosClient.post<AutoScheduleReport>("/schedule/auto-generate", {
        classId: Number(filters.classId), semesterId: Number(filters.semesterId), weekNumber: currentWeek.weekNumber,
      });
      setAutoScheduleReport(res.data);
      loadSchedule();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setAutoScheduleError(axiosErr.response?.data?.message || "Có lỗi xảy ra khi tự động xếp lịch");
    } finally {
      setAutoScheduling(false);
    }
  }

  async function handleCancelAutoSchedule() {
    if (!autoScheduleReport) return;
    if (!confirm("Hủy toàn bộ lần xếp tự động này? Mọi buổi học vừa được tạo trong lần chạy này sẽ bị xóa.")) return;
    await axiosClient.delete(`/schedule/auto-generate/${autoScheduleReport.autoScheduleRunId}`);
    setAutoScheduleReport(null);
    loadSchedule();
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa buổi học này?")) return;
    await axiosClient.delete(`/schedule/${id}`);
    loadSchedule();
  }

  async function handleDeleteGroup(scheduleIds: number[]) {
    if (!confirm(`Xóa cả buổi ghép lớp này (${scheduleIds.length} lớp)?`)) return;
    for (const id of scheduleIds) {
      await axiosClient.delete(`/schedule/${id}`);
    }
    loadSchedule();
  }

  function openNewFormForDaySession(dateKey: string, sessionId: number) {
    setEditingScheduleId(null);
    setEditProgress(null);
    setForm({ ...emptyForm, scheduleDate: dateKey, sessionId: String(sessionId) });
    setShowForm(true);
  }

  function handleExportExcel() {
    if (rows.length === 0) {
      alert("Không có dữ liệu thời khóa biểu để xuất");
      return;
    }

    const weekGroups = new Map<string, ScheduleItem[]>();
    for (const r of rows) {
      const weekStartKey = toDateKey(startOfWeek(parseDateKey(r.ScheduleDate)));
      if (!weekGroups.has(weekStartKey)) weekGroups.set(weekStartKey, []);
      weekGroups.get(weekStartKey)!.push(r);
    }

    const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const sheets = [...weekGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStartKey, weekRows]) => {
        const weekStart = parseDateKey(weekStartKey);
        const weekEnd = addDays(weekStart, 6);
        const sorted = [...weekRows].sort(
          (a, b) => a.ScheduleDate.localeCompare(b.ScheduleDate) || a.StartTime.localeCompare(b.StartTime)
        );
        const sheetRows = sorted.map((r) => {
          const date = parseDateKey(r.ScheduleDate);
          return {
            "Ngày": toDateKey(date),
            "Thứ": WEEKDAY_LABELS[(date.getDay() + 6) % 7],
            "Giờ": `${r.StartTime}–${r.EndTime}`,
            "Lớp": r.ClassName,
            "Môn học": r.SubjectName,
            "Phòng": r.RoomName,
            "Giảng viên": r.Teachers || "",
          };
        });
        return { name: `${fmt(weekStart)}_đến_${fmt(weekEnd)}`, rows: sheetRows };
      });

    const wb = buildWorkbook(sheets);
    const className = filters.classId
      ? classes.find((c) => String(c.ClassId) === filters.classId)?.ClassName
      : null;
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    downloadWorkbook(wb, `TKB_${className || "TatCa"}_${dateStr}.xlsx`);
  }

  const todayKey = toDateKey(new Date());

  return (
    <div>
      <h1>Thời khóa biểu</h1>

      <div className="filter-bar">
        <button type="button" className={viewMode === "byClass" ? "bg-brand-light" : ""} onClick={() => setViewMode("byClass")}>
          Theo lớp
        </button>
        <button type="button" className={viewMode === "allClasses" ? "bg-brand-light" : ""} onClick={() => setViewMode("allClasses")}>
          Tất cả các lớp
        </button>
      </div>

      {viewMode === "byClass" && (
      <>
      <div className="filter-bar">
        <select value={filters.classId} onChange={(e) => setFilters({ classId: e.target.value, semesterId: "" })}>
          <option value="">-- Tất cả lớp --</option>
          {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
        </select>
        <select
          value={filters.semesterId}
          onChange={(e) => setFilters({ ...filters, semesterId: e.target.value })}
          disabled={!filters.classId}
        >
          <option value="">{filters.classId ? "-- Chọn học kỳ để xem lịch --" : "-- Chọn lớp trước --"}</option>
          {semesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
        </select>
        <button type="button" onClick={handleExportExcel}>Xuất Excel</button>
        {isAdmin && (
          <>
            <button type="button" onClick={() => {
              if (editingScheduleId) { handleCancelEdit(); return; }
              setShowForm((v) => !v); setShowMergeForm(false); setShowGroupForm(false); setError("");
            }}>
              {editingScheduleId ? "Đóng form (hủy sửa)" : showForm ? "Đóng form" : "+ Xếp buổi học mới"}
            </button>
            <button type="button" onClick={() => { clearEditingIfActive(); setShowMergeForm((v) => !v); setShowForm(false); setShowGroupForm(false); setMergeError(""); }}>
              {showMergeForm ? "Đóng ghép lớp" : "🔗 Ghép lớp"}
            </button>
            <button type="button" onClick={() => { clearEditingIfActive(); setShowGroupForm((v) => !v); setShowForm(false); setShowMergeForm(false); setGroupError(""); }}>
              {showGroupForm ? "Đóng tách nhóm" : "🧩 Xếp theo nhóm"}
            </button>
          </>
        )}
      </div>

      {isAdmin && showForm && (
        <form className="schedule-form" onSubmit={handleSubmit}>
          <h3>{editingScheduleId ? "Sửa buổi học" : "Xếp buổi học mới"}</h3>
          {editingScheduleId ? (
            <div className="hint mb-2">
              Lớp <b>{selectedFormClass?.ClassName}</b> — Môn <b>{subjectLabel(subjects.find((s) => String(s.SubjectId) === form.subjectId) || { SubjectName: "?", SubjectCode: null, MajorName: null })}</b>
              {" "}— không đổi được Lớp/Kỳ/Môn khi sửa, chỉ chỉnh Phòng/Giảng viên/Ngày/Ca/Số tiết/Ghi chú. Cần đổi Lớp hoặc Môn thì xóa buổi này và xếp lại buổi mới.
              {editProgress && (
                <div className="mt-1">
                  Số tiết buổi này: <b>{form.periodCount || "?"}</b> tiết — Lũy kế đến hết buổi này:
                  {editProgress.theoryTarget > 0 && (
                    <> Lý thuyết <b>{editProgress.cumulativeTheoryPeriods}/{editProgress.theoryTarget}</b> tiết</>
                  )}
                  {editProgress.theoryTarget > 0 && editProgress.practiceTarget > 0 && ", "}
                  {editProgress.practiceTarget > 0 && (
                    <> Thực hành <b>{editProgress.cumulativePracticePeriods}/{editProgress.practiceTarget}</b> tiết</>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="form-grid">
              <div>
                <select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value, semesterId: "", subjectId: "" })} required>
                  <option value="">Lớp</option>
                  {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
                </select>
                {selectedFormClass && (
                  <div className="hint mt-1">
                    <ClassScheduleModeHint cls={selectedFormClass} />
                  </div>
                )}
              </div>
              <select value={form.semesterId} onChange={(e) => setForm({ ...form, semesterId: e.target.value, subjectId: "" })}
                required disabled={!form.classId}>
                <option value="">{form.classId ? "Đợt học" : "-- Chọn lớp trước --"}</option>
                {formSemesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
              </select>
              <select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value, sessionType: "", roomId: "" })}
                required disabled={!formCurriculumSubjectInfo}>
                <option value="">{formCurriculumSubjectInfo ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
                {formSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
              </select>
            </div>
          )}
          <div className="form-grid">
            <select value={form.sessionType} onChange={(e) => setForm({ ...form, sessionType: e.target.value, roomId: "" })} required>
              <option value="">Loại buổi học</option>
              {sessionTypeOptionsForPracticeMode(formPracticeMode).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <div>
              <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}
                required disabled={!form.sessionType}>
                <option value="">{form.sessionType ? "Phòng" : "-- Chọn Loại buổi học trước --"}</option>
                {formRoomsForType.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
              </select>
              {capacityHint && <div className="error-text mt-1">{capacityHint}</div>}
            </div>
            <div>
              <select multiple value={form.teacherIds} className="w-full"
                onChange={(e) => setForm({ ...form, teacherIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {teachers.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
              </select>
              <div className="hint mt-1">Giữ Ctrl (Windows) / Cmd (Mac) để chọn nhiều giảng viên</div>
            </div>
            <input type="date" value={form.scheduleDate}
              onChange={(e) => setForm({ ...form, scheduleDate: e.target.value })} required />
            <div>
              <select value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })} required>
                <option value="">Ca học</option>
                {sessions.map((s) => (
                  <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
                ))}
              </select>
              <input type="number" min={1} placeholder="Số tiết" value={form.periodCount} className="mt-1 w-full"
                onChange={(e) => setForm({ ...form, periodCount: e.target.value })} required />
              {formSession && (
                formEndTimeResult.endTime
                  ? (
                    <div className={formEndTimeResult.overflowMessage ? "error-text mt-1" : "hint mt-1"}>
                      {formEndTimeResult.overflowMessage || `Giờ học: ${formSession.StartTime} - ${formEndTimeResult.endTime}`}
                    </div>
                  )
                  : <div className="hint mt-1">Chọn phòng và nhập số tiết để tính giờ học</div>
              )}
            </div>
            <input placeholder="Ghi chú" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={form.isMakeup}
              onChange={(e) => setForm({ ...form, isMakeup: e.target.checked })} />
            Đây là lịch học bù (bỏ qua cảnh báo ngày/buổi trái quy định hệ đào tạo)
          </label>
          <button type="submit">{editingScheduleId ? "Cập nhật buổi học" : "Thêm buổi học"}</button>
          {editingScheduleId && <button type="button" onClick={handleCancelEdit}>Hủy sửa</button>}
          {error && <div className="error-text">{error}</div>}
        </form>
      )}

      {isAdmin && showMergeForm && (
        <form className="schedule-form" onSubmit={handleMergeSubmit}>
          <h3>🔗 Ghép lớp (nhiều lớp học chung 1 buổi)</h3>
          <div className="form-grid">
            <div>
              <select multiple value={mergeForm.classIds} className="w-full"
                onChange={(e) => setMergeForm({
                  ...mergeForm, classIds: [...e.target.selectedOptions].map((o) => o.value), semesterId: "", subjectId: "",
                })}>
                {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
              </select>
              <div className="hint mt-1">Giữ Ctrl (Windows) / Cmd (Mac) để chọn ít nhất 2 lớp cần ghép</div>
              {selectedMergeClasses.length > 0 && (
                <div className="hint mt-1">
                  Kiểu lịch học: {selectedMergeClasses.map((c) => (
                    `${c.ClassName} (${trainingModeLabel(classScheduleModeEffective(c))}${c.SchedulePatternOverride ? " - ghi đè" : ""})`
                  )).join(", ")}
                  {new Set(selectedMergeClasses.map((c) => classScheduleModeEffective(c))).size > 1 && (
                    <span className="error-text mt-0"> — Các lớp khác kiểu lịch học không thể ghép chung</span>
                  )}
                </div>
              )}
            </div>
            <div>
              <select value={mergeForm.semesterId} onChange={(e) => setMergeForm({ ...mergeForm, semesterId: e.target.value, subjectId: "" })}
                required disabled={mergeForm.classIds.length === 0}>
                <option value="">{mergeForm.classIds.length > 0 ? "Đợt học" : "-- Chọn lớp trước --"}</option>
                {mergeSemesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
              </select>
              {mergeForm.classIds.length > 0 && (
                <div className="hint mt-1">Danh sách Đợt học lấy theo lớp đầu tiên đã chọn — các lớp ghép chung phải cùng Đợt học.</div>
              )}
            </div>
            <select value={mergeForm.subjectId} onChange={(e) => setMergeForm({ ...mergeForm, subjectId: e.target.value, sessionType: "", roomId: "" })}
              required disabled={!mergeCurriculumSubjectInfo}>
              <option value="">{mergeCurriculumSubjectInfo ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
              {mergeSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <select value={mergeForm.sessionType} onChange={(e) => setMergeForm({ ...mergeForm, sessionType: e.target.value, roomId: "" })} required>
              <option value="">Loại buổi học</option>
              {sessionTypeOptionsForPracticeMode(mergePracticeMode).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select value={mergeForm.roomId} onChange={(e) => setMergeForm({ ...mergeForm, roomId: e.target.value })}
              required disabled={!mergeForm.sessionType}>
              <option value="">{mergeForm.sessionType ? "Phòng" : "-- Chọn Loại buổi học trước --"}</option>
              {mergeRoomsForType.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
            </select>
            <div>
              <select multiple value={mergeForm.teacherIds} className="w-full"
                onChange={(e) => setMergeForm({ ...mergeForm, teacherIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {teachers.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
              </select>
              <div className="hint mt-1">Giữ Ctrl (Windows) / Cmd (Mac) để chọn nhiều giảng viên</div>
            </div>
            <input type="date" value={mergeForm.scheduleDate}
              onChange={(e) => setMergeForm({ ...mergeForm, scheduleDate: e.target.value })} required />
            <div>
              <select value={mergeForm.sessionId} onChange={(e) => setMergeForm({ ...mergeForm, sessionId: e.target.value })} required>
                <option value="">Ca học</option>
                {sessions.map((s) => (
                  <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
                ))}
              </select>
              <input type="number" min={1} placeholder="Số tiết" value={mergeForm.periodCount} className="mt-1 w-full"
                onChange={(e) => setMergeForm({ ...mergeForm, periodCount: e.target.value })} required />
              {mergeSession && (
                mergeEndTimeResult.endTime
                  ? (
                    <div className={mergeEndTimeResult.overflowMessage ? "error-text mt-1" : "hint mt-1"}>
                      {mergeEndTimeResult.overflowMessage || `Giờ học: ${mergeSession.StartTime} - ${mergeEndTimeResult.endTime}`}
                    </div>
                  )
                  : <div className="hint mt-1">Chọn phòng và nhập số tiết để tính giờ học</div>
              )}
            </div>
            <input placeholder="Ghi chú" value={mergeForm.note}
              onChange={(e) => setMergeForm({ ...mergeForm, note: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={mergeForm.isMakeup}
              onChange={(e) => setMergeForm({ ...mergeForm, isMakeup: e.target.checked })} />
            Đây là lịch học bù (bỏ qua cảnh báo ngày/buổi trái quy định hệ đào tạo)
          </label>
          <button type="submit">Ghép lớp</button>
          {mergeError && <div className="error-text">{mergeError}</div>}
        </form>
      )}

      {isAdmin && showGroupForm && (
        <form className="schedule-form" onSubmit={handleGroupSubmit}>
          <h3>🧩 Xếp theo nhóm (1 lớp chia nhiều nhóm học song song)</h3>
          <div className="form-grid">
            <div>
              <select value={groupForm.classId} onChange={(e) => setGroupForm({ ...groupForm, classId: e.target.value, semesterId: "", subjectId: "" })} required>
                <option value="">Lớp</option>
                {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
              </select>
              {selectedGroupClass && (
                <div className="hint mt-1">Sĩ số lớp: {selectedGroupClass.ClassSize} — chia đều hoặc theo thực tế vào các nhóm bên dưới</div>
              )}
            </div>
            <select value={groupForm.semesterId} onChange={(e) => setGroupForm({ ...groupForm, semesterId: e.target.value, subjectId: "" })}
              required disabled={!groupForm.classId}>
              <option value="">{groupForm.classId ? "Đợt học" : "-- Chọn lớp trước --"}</option>
              {groupSemesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
            </select>
            <select value={groupForm.subjectId} onChange={(e) => setGroupForm({
              ...groupForm, subjectId: e.target.value, sessionType: "",
              groups: groupForm.groups.map((g) => ({ ...g, roomId: "" })),
            })}
              required disabled={!groupCurriculumSubjectInfo}>
              <option value="">{groupCurriculumSubjectInfo ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
              {groupSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <select value={groupForm.sessionType} onChange={(e) => setGroupForm({
              ...groupForm, sessionType: e.target.value,
              groups: groupForm.groups.map((g) => ({ ...g, roomId: "" })),
            })} required>
              <option value="">Loại buổi học</option>
              {sessionTypeOptionsForPracticeMode(groupPracticeMode).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <div>
              <input type="date" value={groupForm.scheduleDate}
                onChange={(e) => setGroupForm({ ...groupForm, scheduleDate: e.target.value })} />
              <div className="hint mt-1">Ngày mặc định — mỗi nhóm có thể tự chọn ngày khác bên dưới</div>
            </div>
            <div>
              <select value={groupForm.sessionId} onChange={(e) => setGroupForm({ ...groupForm, sessionId: e.target.value })}>
                <option value="">Ca học mặc định</option>
                {sessions.map((s) => (
                  <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
                ))}
              </select>
              <input type="number" min={1} placeholder="Số tiết mặc định" value={groupForm.periodCount} className="mt-1 w-full"
                onChange={(e) => setGroupForm({ ...groupForm, periodCount: e.target.value })} />
              <div className="hint mt-1">Ca/Số tiết mặc định khi bấm "+ Thêm nhóm" — mỗi nhóm tự chọn riêng được bên dưới (xoay vòng khác giờ nếu chỉ có 1 phòng)</div>
            </div>
            <input placeholder="Ghi chú" value={groupForm.note}
              onChange={(e) => setGroupForm({ ...groupForm, note: e.target.value })} />
          </div>

          <div className="mt-3">
            {groupForm.groups.map((g, idx) => {
              const computed = groupRowsComputed[idx];
              return (
                <div key={idx} className="inline-form mb-2 items-start">
                  <input placeholder="Tên nhóm (vd Nhóm 1)" value={g.groupLabel}
                    onChange={(e) => updateGroupRow(idx, { groupLabel: e.target.value })} required />
                  <input type="date" value={g.scheduleDate}
                    onChange={(e) => updateGroupRow(idx, { scheduleDate: e.target.value })} required />
                  <div>
                    <select value={g.sessionId} onChange={(e) => updateGroupRow(idx, { sessionId: e.target.value })} required>
                      <option value="">Ca học</option>
                      {sessions.map((s) => (
                        <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
                      ))}
                    </select>
                    <input type="number" min={1} placeholder="Số tiết" value={g.periodCount} className="mt-1 w-full"
                      onChange={(e) => updateGroupRow(idx, { periodCount: e.target.value })} required />
                  </div>
                  <select value={g.roomId} onChange={(e) => updateGroupRow(idx, { roomId: e.target.value })}
                    required disabled={!groupForm.sessionType}>
                    <option value="">{groupForm.sessionType ? "Phòng" : "-- Chọn Loại buổi học trước --"}</option>
                    {groupRoomsForType.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
                  </select>
                  <select multiple value={g.teacherIds}
                    onChange={(e) => updateGroupRow(idx, { teacherIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                    {teachers.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
                  </select>
                  {groupForm.groups.length > 2 && (
                    <button type="button" onClick={() => removeGroupRow(idx)}>Xóa nhóm</button>
                  )}
                  <div className="basis-full">
                    {computed?.session && (
                      computed.endTimeResult.endTime
                        ? (
                          <div className={computed.endTimeResult.overflowMessage ? "error-text mt-0" : "hint mt-0"}>
                            {computed.endTimeResult.overflowMessage || `Giờ học: ${computed.session.StartTime} - ${computed.endTimeResult.endTime}`}
                          </div>
                        )
                        : <div className="hint mt-0">Chọn Phòng và nhập số tiết để tính giờ học cho nhóm này</div>
                    )}
                  </div>
                </div>
              );
            })}
            <button type="button" onClick={addGroupRow}>+ Thêm nhóm</button>
            <div className="hint mt-1">Mỗi nhóm tự chọn Ngày/Ca riêng — xoay vòng dùng chung 1 phòng ở các buổi khác nhau nếu trường không đủ phòng. Giữ Ctrl (Windows) / Cmd (Mac) để chọn nhiều giảng viên trong 1 nhóm.</div>
          </div>

          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={groupForm.isMakeup}
              onChange={(e) => setGroupForm({ ...groupForm, isMakeup: e.target.checked })} />
            Đây là lịch học bù (bỏ qua cảnh báo ngày/buổi trái quy định hệ đào tạo)
          </label>
          <button type="submit">Xếp theo nhóm</button>
          {groupError && <div className="error-text">{groupError}</div>}
        </form>
      )}

      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <button type="button" onClick={goPrevWeek} disabled={!currentWeek || selectedWeekIndex === 0}>‹</button>
          <select
            value={selectedWeekIndex}
            onChange={(e) => setSelectedWeekIndex(Number(e.target.value))}
            disabled={semesterWeeks.length === 0}
          >
            {semesterWeeks.length === 0 && <option>-- Chưa có tuần --</option>}
            {semesterWeeks.map((w, idx) => (
              <option key={w.weekNumber} value={idx}>Tuần {w.weekNumber}</option>
            ))}
          </select>
          <button type="button" onClick={goNextWeek} disabled={!currentWeek || selectedWeekIndex === semesterWeeks.length - 1}>›</button>
          <button type="button" onClick={goCurrentWeek} disabled={findTodayWeekIndex(semesterWeeks) < 0}>Tuần hiện tại</button>
          {currentWeek && (
            <span className="calendar-title">
              Tuần {currentWeek.weekNumber} ({fmtDDMM(currentWeek.start)} - {fmtDDMMYYYY(currentWeek.end)})
            </span>
          )}
        </div>
        {isAdmin && currentWeek && (
          <button
            type="button"
            onClick={() => {
              setShowCopyWeekForm((v) => !v);
              setCopyWeekTargetIndex(String(Math.min(selectedWeekIndex + 1, semesterWeeks.length - 1)));
              setCopyWeekError("");
            }}
          >
            {showCopyWeekForm ? "Đóng sao chép lịch" : "📋 Sao chép lịch tuần này"}
          </button>
        )}
        {isAdmin && currentWeek && (
          <button type="button" disabled={autoScheduling} onClick={handleAutoSchedule}>
            {autoScheduling ? "Đang tự động xếp..." : "🤖 Tự động xếp lịch tuần này"}
          </button>
        )}
      </div>

      {isAdmin && autoScheduleError && <div className="error-text">{autoScheduleError}</div>}

      {isAdmin && autoScheduleReport && (
        <div className="inline-form items-start flex-col">
          <p className="hint">
            Tuần {currentWeek?.weekNumber}: đã xếp được {autoScheduleReport.totalPeriodsScheduled}/{autoScheduleReport.totalPeriodsNeeded} tiết
            theo chỉ tiêu tuần này (chia đều số tiết còn thiếu cả Kỳ cho số tuần còn lại). Có thể chuyển sang
            Tuần kế tiếp rồi bấm lại để tiếp tục xếp dần.
          </p>
          <table className="data-table">
            <thead>
              <tr><th>Môn học</th><th>Đã xếp / Chỉ tiêu tuần</th><th>Trạng thái</th></tr>
            </thead>
            <tbody>
              {autoScheduleReport.subjectResults.map((r) => (
                <tr key={r.subjectId} className={r.isComplete ? "" : "row-danger"}>
                  <td>{r.subjectName}</td>
                  <td>{r.periodsScheduled}/{r.periodsNeeded} tiết</td>
                  <td>
                    {r.isComplete
                      ? <span className="text-green-600 text-[13px]">✓ Đủ</span>
                      : <span className="error-text mt-0">Thiếu — {r.failureReason || "chưa xếp đủ"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={() => setAutoScheduleReport(null)}>Đóng</button>
            <button type="button" onClick={handleCancelAutoSchedule}>Hủy toàn bộ lần xếp này</button>
          </div>
        </div>
      )}

      {isAdmin && currentWeek && showCopyWeekForm && (
        <form className="schedule-form" onSubmit={handleCopyWeek}>
          <h3>📋 Sao chép lịch Tuần {currentWeek.weekNumber} ({fmtDDMM(currentWeek.start)} - {fmtDDMMYYYY(currentWeek.end)}) sang tuần khác trong kỳ</h3>
          <div className="form-grid">
            <select value={copyWeekTargetIndex} onChange={(e) => setCopyWeekTargetIndex(e.target.value)} required>
              <option value="">Tuần đích</option>
              {semesterWeeks.map((w, idx) => (
                <option key={w.weekNumber} value={idx} disabled={idx === selectedWeekIndex}>
                  Tuần {w.weekNumber} ({fmtDDMM(w.start)} - {fmtDDMMYYYY(w.end)})
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Sao chép lịch</button>
          {copyWeekError && <div className="error-text">{copyWeekError}</div>}
        </form>
      )}

      {!filters.classId ? (
        <p className="hint">Vui lòng chọn Lớp học ở trên để xem thời khóa biểu (mỗi lớp có bộ Kỳ học riêng).</p>
      ) : !currentWeek ? (
        <p className="hint">Vui lòng chọn Học kỳ ở trên để xem thời khóa biểu theo tuần.</p>
      ) : sessions.length === 0 ? (
        <p className="hint">
          Chưa có Ca học nào — vào mục "Ca học" trong Danh mục để khai báo trước khi xem theo lưới ca.
        </p>
      ) : (
        <>
          <div className="calendar-grid-wrap">
            <table className="calendar-grid-table">
              <thead>
                <tr>
                  <th className="calendar-grid-period-col">Ca</th>
                  {weekDays.map((day) => {
                    const key = toDateKey(day);
                    return (
                      <th key={key} className={key === todayKey ? "text-brand" : ""}>
                        {WEEKDAY_LABELS[(day.getDay() + 6) % 7]}
                        <div className="text-[11px] font-normal text-gray-400">{day.getDate()}/{day.getMonth() + 1}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.SessionId}>
                    <td className="calendar-grid-period-col">
                      <div className="font-medium text-gray-700">{session.SessionName}</div>
                      <div className="text-[11px] text-gray-400">{session.StartTime}–{session.EndTime}</div>
                    </td>
                    {weekDays.map((day) => {
                      const key = toDateKey(day);
                      const grid = weekDayGrids[key];
                      const events = grid?.bySession.get(session.SessionId) || [];
                      const groups = groupMergedEvents(events);
                      if (groups.length === 0) {
                        return (
                          <td
                            key={key}
                            className="calendar-grid-empty"
                            onClick={() => isAdmin && openNewFormForDaySession(key, session.SessionId)}
                          />
                        );
                      }
                      return (
                        <td key={key} className="calendar-grid-event">
                          <div className="calendar-grid-event-inner">
                            {groups.map((g) => {
                              const ev = g.events[0];
                              const color = colorForId(ev.SubjectId);
                              const scheduleIds = g.events.map((e) => e.ScheduleId);
                              return (
                                <div key={g.key} className="calendar-event-card" style={{ background: color.bg, color: color.text }}>
                                  <EventCardContent ev={ev} g={g} progress={periodProgress[ev.ScheduleId]} />
                                  {isAdmin && (
                                    g.isMerged
                                      ? <button className="calendar-event-delete mt-auto self-start" onClick={() => handleDeleteGroup(scheduleIds)}>Xóa cả buổi ghép</button>
                                      : (
                                        <div className="calendar-event-actions">
                                          <button className="calendar-event-edit" onClick={() => handleOpenEdit(ev.ScheduleId)}>Sửa</button>
                                          <button className="calendar-event-delete" onClick={() => handleDelete(ev.ScheduleId)}>Xóa</button>
                                        </div>
                                      )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {weekDays.some((day) => (weekDayGrids[toDateKey(day)]?.leftover.length ?? 0) > 0) && (
            <div className="mt-4">
              <p className="hint mb-2">
                ⚠ Các buổi học sau có giờ không khớp với Ca học nào (có thể do nhập giờ tùy chỉnh trước đây):
              </p>
              <table className="data-table">
                <thead><tr><th>Ngày</th><th>Giờ</th><th>Lớp</th><th>Môn</th><th>Phòng</th>{isAdmin && <th></th>}</tr></thead>
                <tbody>
                  {weekDays.flatMap((day) => {
                    const key = toDateKey(day);
                    return (weekDayGrids[key]?.leftover || []).map((ev) => (
                      <tr key={ev.ScheduleId}>
                        <td>{key}</td>
                        <td>{ev.StartTime}–{ev.EndTime}</td>
                        <td>{ev.ClassName}</td>
                        <td>{ev.SubjectName}</td>
                        <td>{ev.RoomName}</td>
                        {isAdmin && <td><button onClick={() => handleDelete(ev.ScheduleId)}>Xóa</button></td>}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      </>
      )}

      {viewMode === "allClasses" && (
      <div>
        <div className="filter-bar">
          <select value={allClassesCohortId} onChange={(e) => setAllClassesCohortId(e.target.value)}>
            <option value="">-- Chọn Khóa học --</option>
            {cohorts.filter((c) => c.IsActive).map((c) => <option key={c.CohortId} value={c.CohortId}>{c.CohortName}</option>)}
          </select>
          <select value={allClassesTrainingMode} onChange={(e) => setAllClassesTrainingMode(e.target.value)} disabled={!allClassesCohortId}>
            <option value="">-- Tất cả hệ đào tạo --</option>
            <option value="CQ">Chính quy (CQ)</option>
            <option value="LT">Liên thông (LT)</option>
          </select>
        </div>

        {!allClassesCohortId ? (
          <p className="hint">Vui lòng chọn Khóa học để xem thời khóa biểu tổng hợp toàn trường theo tuần.</p>
        ) : visibleAllClasses.length === 0 ? (
          <p className="hint">Khóa này chưa có lớp nào đang sử dụng (hoặc không có lớp nào khớp bộ lọc Hệ đào tạo).</p>
        ) : (
          <>
            <div className="calendar-toolbar">
              <div className="calendar-nav">
                <button type="button" onClick={() => setAllClassesWeekStart((d) => addDays(d, -7))}>‹</button>
                <select
                  value={allClassesSelectedYear}
                  onChange={(e) => setAllClassesWeekStart(mondayOfISOWeek(Number(e.target.value), allClassesSelectedWeek))}
                >
                  {allClassesYearOptions.map((y) => <option key={y} value={y}>Năm {y}</option>)}
                </select>
                <select
                  value={allClassesSelectedWeek}
                  onChange={(e) => setAllClassesWeekStart(mondayOfISOWeek(allClassesSelectedYear, Number(e.target.value)))}
                >
                  {Array.from({ length: 53 }, (_, i) => i + 1).map((w) => <option key={w} value={w}>Tuần {w}</option>)}
                </select>
                <button type="button" onClick={() => setAllClassesWeekStart((d) => addDays(d, 7))}>›</button>
                <button type="button" onClick={() => setAllClassesWeekStart(startOfWeek(new Date()))}>Tuần hiện tại</button>
                <span className="calendar-title">
                  ({fmtDDMMYYYY(allClassesWeekStart)} - {fmtDDMMYYYY(addDays(allClassesWeekStart, 6))})
                </span>
              </div>
            </div>

            <div className="calendar-grid-wrap">
              <table className="calendar-grid-table">
                <thead>
                  <tr>
                    <th colSpan={2} className="calendar-grid-period-col">Buổi</th>
                    {visibleAllClasses.map((c) => (
                      <th key={c.ClassId}>
                        {c.ClassName}
                        <div className="text-[11px] font-normal text-gray-400">
                          {trainingModeLabel(classScheduleModeEffective(c))}{c.SchedulePatternOverride ? " (ghi đè)" : ""} · {c.ClassSize} SV
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allClassesVisibleDays.flatMap((day) => {
                    const dateKey = toDateKey(day);
                    return sessions.map((session, sessionIdx) => (
                      <tr key={`${dateKey}-${session.SessionId}`}>
                        {sessionIdx === 0 && (
                          <td rowSpan={sessions.length} className={`calendar-grid-period-col ${dateKey === todayKey ? "text-brand" : ""}`}>
                            <div className="font-medium">{WEEKDAY_LABELS[(day.getDay() + 6) % 7]}</div>
                            <div className="text-[11px] text-gray-400">{fmtDDMM(day)}</div>
                          </td>
                        )}
                        <td className="calendar-grid-period-col">
                          <div className="font-medium text-gray-700">{session.SessionName}</div>
                          <div className="text-[11px] text-gray-400">{session.StartTime}–{session.EndTime}</div>
                        </td>
                        {visibleAllClasses.map((cls) => {
                          const events = allClassesGrid.get(cls.ClassId)?.get(dateKey)?.get(session.SessionId) || [];
                          const groups = groupMergedEvents(events);
                          return (
                            <td key={cls.ClassId} className="calendar-grid-event">
                              {groups.length > 0 && (
                                <div className="calendar-grid-event-inner">
                                  {groups.map((g) => {
                                    const ev = g.events[0];
                                    const color = colorForId(ev.SubjectId);
                                    return (
                                      <div key={g.key} className="calendar-event-card" style={{ background: color.bg, color: color.text }}>
                                        <EventCardContent ev={ev} g={g} progress={allClassesPeriodProgress[ev.ScheduleId]} />
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
