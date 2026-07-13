import { FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { useAuth } from "../../context/AuthContext";
import { ScheduleItem, Semester, SchoolClass, Subject, Room, Teacher, Session, SchedulingPolicyItem, ApiErrorResponse, CopyWeekResult, CurriculumItem } from "../../types";
import { AxiosError } from "axios";
import { addDays, addMinutesToTime, colorForId, findTodayWeekIndex, getWeeksInSemester, parseDateKey, startOfWeek, toDateKey, WEEKDAY_LABELS } from "../../../utils/calendar";
import { buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { subjectLabel } from "../../../utils/text";

interface ScheduleForm {
  semesterId: string;
  classId: string;
  subjectId: string;
  roomId: string;
  teacherIds: string[];
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
}

const emptyForm: ScheduleForm = {
  semesterId: "", classId: "", subjectId: "", roomId: "",
  teacherIds: [], scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
};

interface MergeForm {
  semesterId: string;
  classIds: string[];
  subjectId: string;
  roomId: string;
  teacherIds: string[];
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
}

const emptyMergeForm: MergeForm = {
  semesterId: "", classIds: [], subjectId: "", roomId: "",
  teacherIds: [], scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
};

interface GroupRow {
  groupLabel: string;
  roomId: string;
  teacherIds: string[];
}

interface GroupForm {
  semesterId: string;
  classId: string;
  subjectId: string;
  scheduleDate: string;
  sessionId: string;
  periodCount: string;
  note: string;
  isMakeup: boolean;
  groups: GroupRow[];
}

const emptyGroupRow: GroupRow = { groupLabel: "", roomId: "", teacherIds: [] };
const emptyGroupForm: GroupForm = {
  semesterId: "", classId: "", subjectId: "", scheduleDate: "", sessionId: "", periodCount: "", note: "", isMakeup: false,
  groups: [{ ...emptyGroupRow, groupLabel: "Nhóm 1" }, { ...emptyGroupRow, groupLabel: "Nhóm 2" }],
};

const CAPACITY_POLICY_BY_ROOM_TYPE: Record<string, string> = {
  LyThuyet: "MaxStudentsPerTheoryRoom",
  ThucHanh: "MaxStudentsPerPracticeGroup",
  LamSang: "MaxStudentsPerClinicalGroup",
};

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
async function loadCurriculumSubjectIds(majorId?: number, termNumber?: number | null, cohortId?: number | null): Promise<Set<number>> {
  if (!majorId || !termNumber) return new Set();
  const params: Record<string, string> = { majorId: String(majorId), termNumber: String(termNumber) };
  if (cohortId) params.cohortId = String(cohortId);
  const res = await axiosClient.get<CurriculumItem[]>("/curriculum-items", { params });
  return new Set(res.data.map((ci) => ci.SubjectId));
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

export default function ScheduleGrid() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<ScheduleItem[]>([]);
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

  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);

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
  const [formCurriculumSubjectIds, setFormCurriculumSubjectIds] = useState<Set<number> | null>(null);
  const [mergeCurriculumSubjectIds, setMergeCurriculumSubjectIds] = useState<Set<number> | null>(null);
  const [groupCurriculumSubjectIds, setGroupCurriculumSubjectIds] = useState<Set<number> | null>(null);

  useEffect(() => {
    if (!selectedFormClass || !selectedFormSemester) { setFormCurriculumSubjectIds(null); return; }
    loadCurriculumSubjectIds(selectedFormClass.MajorId, selectedFormSemester.TermNumber, selectedFormClass.CohortId)
      .then(setFormCurriculumSubjectIds);
  }, [selectedFormClass?.MajorId, selectedFormClass?.CohortId, selectedFormSemester?.TermNumber]);

  useEffect(() => {
    const first = selectedMergeClasses[0] || null;
    if (!first || !selectedMergeSemester) { setMergeCurriculumSubjectIds(null); return; }
    loadCurriculumSubjectIds(first.MajorId, selectedMergeSemester.TermNumber, first.CohortId)
      .then(setMergeCurriculumSubjectIds);
  }, [selectedMergeClasses[0]?.MajorId, selectedMergeClasses[0]?.CohortId, selectedMergeSemester?.TermNumber]);

  useEffect(() => {
    if (!selectedGroupClass || !selectedGroupSemester) { setGroupCurriculumSubjectIds(null); return; }
    loadCurriculumSubjectIds(selectedGroupClass.MajorId, selectedGroupSemester.TermNumber, selectedGroupClass.CohortId)
      .then(setGroupCurriculumSubjectIds);
  }, [selectedGroupClass?.MajorId, selectedGroupClass?.CohortId, selectedGroupSemester?.TermNumber]);

  const formSubjects = useMemo(
    () => (formCurriculumSubjectIds ? subjects.filter((s) => formCurriculumSubjectIds.has(s.SubjectId)) : []),
    [subjects, formCurriculumSubjectIds]
  );
  const mergeSubjects = useMemo(
    () => (mergeCurriculumSubjectIds ? subjects.filter((s) => mergeCurriculumSubjectIds.has(s.SubjectId)) : []),
    [subjects, mergeCurriculumSubjectIds]
  );
  const groupSubjects = useMemo(
    () => (groupCurriculumSubjectIds ? subjects.filter((s) => groupCurriculumSubjectIds.has(s.SubjectId)) : []),
    [subjects, groupCurriculumSubjectIds]
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

  const groupRepresentativeRoom = useMemo(
    () => rooms.find((r) => String(r.RoomId) === groupForm.groups[0]?.roomId) || null,
    [rooms, groupForm.groups]
  );
  const groupSession = useMemo(() => sessions.find((s) => s.SessionId === Number(groupForm.sessionId)) || null, [sessions, groupForm.sessionId]);
  const groupEndTimeResult = useMemo(
    () => computeEndTime(groupSession, groupRepresentativeRoom, groupForm.periodCount, policies),
    [groupSession, groupRepresentativeRoom, groupForm.periodCount, policies]
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
    const [cls, subj, room, tch, ses, policy] = await Promise.all([
      axiosClient.get<SchoolClass[]>("/classes"),
      axiosClient.get<Subject[]>("/subjects", { params: { isActive: true } }),
      axiosClient.get<Room[]>("/rooms"),
      axiosClient.get<Teacher[]>("/teachers"),
      axiosClient.get<Session[]>("/sessions"),
      axiosClient.get<SchedulingPolicyItem[]>("/scheduling-policy"),
    ]);
    setClasses(cls.data); setSubjects(subj.data);
    setRooms(room.data); setTeachers(tch.data);
    setSessions(ses.data.sort((a, b) => a.SortOrder - b.SortOrder));
    setPolicies(Object.fromEntries(policy.data.map((p) => [p.PolicyKey, Number(p.PolicyValue)])));
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
    };
    try {
      const res = await axiosClient.post<{ warning?: string }>("/schedule", payload);
      if (res.data.warning) alert(res.data.warning);
      setForm(emptyForm);
      setShowForm(false);
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

  function addGroupRow() {
    setGroupForm({
      ...groupForm,
      groups: [...groupForm.groups, { ...emptyGroupRow, groupLabel: `Nhóm ${groupForm.groups.length + 1}` }],
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

    const session = sessions.find((s) => s.SessionId === Number(groupForm.sessionId));
    if (!session) {
      setGroupError("Vui lòng chọn ca học");
      return;
    }
    if (groupForm.groups.some((g) => !g.groupLabel.trim() || !g.roomId)) {
      setGroupError("Mỗi nhóm cần có tên nhóm và phòng học");
      return;
    }
    if (!groupForm.periodCount || Number(groupForm.periodCount) <= 0) {
      setGroupError("Vui lòng nhập số tiết");
      return;
    }
    if (!groupEndTimeResult.endTime || groupEndTimeResult.overflowMessage) {
      setGroupError(groupEndTimeResult.overflowMessage || "Không tính được giờ kết thúc (kiểm tra Phòng của Nhóm 1)");
      return;
    }

    const payload = {
      semesterId: Number(groupForm.semesterId),
      classId: Number(groupForm.classId),
      subjectId: Number(groupForm.subjectId),
      scheduleDate: groupForm.scheduleDate,
      startTime: session.StartTime,
      endTime: groupEndTimeResult.endTime,
      note: groupForm.note,
      isMakeup: groupForm.isMakeup,
      groups: groupForm.groups.map((g) => ({
        groupLabel: g.groupLabel.trim(),
        roomId: Number(g.roomId),
        teacherIds: g.teacherIds.map(Number),
      })),
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
            <button type="button" onClick={() => { setShowForm((v) => !v); setShowMergeForm(false); setShowGroupForm(false); setError(""); }}>
              {showForm ? "Đóng form" : "+ Xếp buổi học mới"}
            </button>
            <button type="button" onClick={() => { setShowMergeForm((v) => !v); setShowForm(false); setShowGroupForm(false); setMergeError(""); }}>
              {showMergeForm ? "Đóng ghép lớp" : "🔗 Ghép lớp"}
            </button>
            <button type="button" onClick={() => { setShowGroupForm((v) => !v); setShowForm(false); setShowMergeForm(false); setGroupError(""); }}>
              {showGroupForm ? "Đóng tách nhóm" : "🧩 Xếp theo nhóm"}
            </button>
          </>
        )}
      </div>

      {isAdmin && showForm && (
        <form className="schedule-form" onSubmit={handleSubmit}>
          <h3>Xếp buổi học mới</h3>
          <div className="form-grid">
            <div>
              <select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value, semesterId: "", subjectId: "" })} required>
                <option value="">Lớp</option>
                {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
              </select>
              {selectedFormClass && (
                <div className="hint mt-1">
                  Hệ đào tạo: <b>{trainingModeLabel(selectedFormClass.TrainingMode)}</b> — {trainingModeHint(selectedFormClass.TrainingMode)}
                </div>
              )}
            </div>
            <select value={form.semesterId} onChange={(e) => setForm({ ...form, semesterId: e.target.value, subjectId: "" })}
              required disabled={!form.classId}>
              <option value="">{form.classId ? "Đợt học" : "-- Chọn lớp trước --"}</option>
              {formSemesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
            </select>
            <select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}
              required disabled={!formCurriculumSubjectIds}>
              <option value="">{formCurriculumSubjectIds ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
              {formSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <div>
              <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })} required>
                <option value="">Phòng</option>
                {rooms.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
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
          <button type="submit">Thêm buổi học</button>
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
                  Hệ đào tạo: {selectedMergeClasses.map((c) => `${c.ClassName} (${trainingModeLabel(c.TrainingMode)})`).join(", ")}
                  {new Set(selectedMergeClasses.map((c) => c.TrainingMode)).size > 1 && (
                    <span className="error-text mt-0"> — Các lớp khác hệ đào tạo không thể ghép chung</span>
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
            <select value={mergeForm.subjectId} onChange={(e) => setMergeForm({ ...mergeForm, subjectId: e.target.value })}
              required disabled={!mergeCurriculumSubjectIds}>
              <option value="">{mergeCurriculumSubjectIds ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
              {mergeSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <select value={mergeForm.roomId} onChange={(e) => setMergeForm({ ...mergeForm, roomId: e.target.value })} required>
              <option value="">Phòng</option>
              {rooms.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
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
            <select value={groupForm.subjectId} onChange={(e) => setGroupForm({ ...groupForm, subjectId: e.target.value })}
              required disabled={!groupCurriculumSubjectIds}>
              <option value="">{groupCurriculumSubjectIds ? "Môn học" : "-- Chọn Lớp và Kỳ trước --"}</option>
              {groupSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <input type="date" value={groupForm.scheduleDate}
              onChange={(e) => setGroupForm({ ...groupForm, scheduleDate: e.target.value })} required />
            <div>
              <select value={groupForm.sessionId} onChange={(e) => setGroupForm({ ...groupForm, sessionId: e.target.value })} required>
                <option value="">Ca học</option>
                {sessions.map((s) => (
                  <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
                ))}
              </select>
              <input type="number" min={1} placeholder="Số tiết" value={groupForm.periodCount} className="mt-1 w-full"
                onChange={(e) => setGroupForm({ ...groupForm, periodCount: e.target.value })} required />
              {groupSession && (
                groupEndTimeResult.endTime
                  ? (
                    <div className={groupEndTimeResult.overflowMessage ? "error-text mt-1" : "hint mt-1"}>
                      {groupEndTimeResult.overflowMessage || `Giờ học: ${groupSession.StartTime} - ${groupEndTimeResult.endTime}`}
                    </div>
                  )
                  : <div className="hint mt-1">Chọn Phòng cho Nhóm 1 bên dưới và nhập số tiết để tính giờ học (độ dài tiết tính theo loại phòng của Nhóm 1)</div>
              )}
            </div>
            <input placeholder="Ghi chú" value={groupForm.note}
              onChange={(e) => setGroupForm({ ...groupForm, note: e.target.value })} />
          </div>

          <div className="mt-3">
            {groupForm.groups.map((g, idx) => (
              <div key={idx} className="inline-form mb-2">
                <input placeholder="Tên nhóm (vd Nhóm 1)" value={g.groupLabel}
                  onChange={(e) => updateGroupRow(idx, { groupLabel: e.target.value })} required />
                <select value={g.roomId} onChange={(e) => updateGroupRow(idx, { roomId: e.target.value })} required>
                  <option value="">Phòng</option>
                  {rooms.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
                </select>
                <select multiple value={g.teacherIds}
                  onChange={(e) => updateGroupRow(idx, { teacherIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {teachers.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
                </select>
                {groupForm.groups.length > 2 && (
                  <button type="button" onClick={() => removeGroupRow(idx)}>Xóa nhóm</button>
                )}
              </div>
            ))}
            <button type="button" onClick={addGroupRow}>+ Thêm nhóm</button>
            <div className="hint mt-1">Giữ Ctrl (Windows) / Cmd (Mac) để chọn nhiều giảng viên trong 1 nhóm</div>
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
      </div>

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
                              const classNames = g.events.map((e) => e.ClassName).join(", ");
                              const scheduleIds = g.events.map((e) => e.ScheduleId);
                              return (
                                <div key={g.key} className="calendar-event-card" style={{ background: color.bg, color: color.text }}>
                                  <div className="calendar-event-title">
                                    {g.isMerged && <span title="Buổi ghép lớp">🔗 </span>}{ev.SubjectName}
                                    {ev.GroupLabel && <span title="Buổi tách nhóm"> · {ev.GroupLabel}</span>}
                                  </div>
                                  <div className="calendar-event-sub">{classNames} · {ev.RoomName}</div>
                                  {ev.Teachers && <div className="calendar-event-sub">{ev.Teachers}</div>}
                                  {isAdmin && (
                                    g.isMerged
                                      ? <button className="calendar-event-delete" onClick={() => handleDeleteGroup(scheduleIds)}>Xóa cả buổi ghép</button>
                                      : <button className="calendar-event-delete" onClick={() => handleDelete(ev.ScheduleId)}>Xóa</button>
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
    </div>
  );
}
