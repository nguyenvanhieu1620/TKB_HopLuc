import { FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { useAuth } from "../../context/AuthContext";
import { ExamItem, ExamType, Semester, SchoolClass, Subject, Room, Teacher, Session, SchedulingPolicyItem, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";
import { subjectLabel } from "../../../utils/text";

const EXAM_TYPES: { value: ExamType; label: string }[] = [
  { value: "TuLuan", label: "Tự luận" },
  { value: "TracNghiem", label: "Trắc nghiệm" },
  { value: "VanDap", label: "Vấn đáp" },
  { value: "ThucHanh", label: "Thực hành" },
];

interface ExamForm {
  semesterId: string;
  classId: string;
  subjectId: string;
  roomId: string;
  proctorIds: string[];
  examDate: string;
  sessionId: string;
  examType: ExamType;
  note: string;
}

const emptyForm: ExamForm = {
  semesterId: "", classId: "", subjectId: "", roomId: "",
  proctorIds: [], examDate: "", sessionId: "", examType: "TuLuan", note: "",
};

export default function ExamList() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<ExamItem[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [minProctors, setMinProctors] = useState(1);
  const [filters, setFilters] = useState({ semesterId: "", classId: "" });
  const [form, setForm] = useState<ExamForm>(emptyForm);
  const [formSemesters, setFormSemesters] = useState<Semester[]>([]);
  const [error, setError] = useState("");

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
    const minProctorsPolicy = policy.data.find((p) => p.PolicyKey === "MinProctorsPerExam");
    if (minProctorsPolicy) setMinProctors(Number(minProctorsPolicy.PolicyValue));
  }

  // Mỗi Lớp có bộ Kỳ học riêng — nạp lại Đợt học theo đúng classId đang chọn (bộ lọc trên
  // cùng, và riêng cho form xếp ca thi mới).
  async function loadSemestersFor(classId: string): Promise<Semester[]> {
    if (!classId) return [];
    const res = await axiosClient.get<Semester[]>("/semesters", { params: { classId } });
    return res.data;
  }

  async function loadExams() {
    const params: Record<string, string> = {};
    if (filters.semesterId) params.semesterId = filters.semesterId;
    if (filters.classId) params.classId = filters.classId;
    const res = await axiosClient.get<ExamItem[]>("/exams", { params });
    setRows(res.data);
  }

  useEffect(() => { loadLookups(); }, []);
  useEffect(() => { loadExams(); }, [filters]);
  useEffect(() => { loadSemestersFor(filters.classId).then(setSemesters); }, [filters.classId]);
  useEffect(() => { loadSemestersFor(form.classId).then(setFormSemesters); }, [form.classId]);

  // Việc AR: mỗi Lớp thuộc 1 Ngành cố định — chỉ hiện các môn của đúng Ngành đó trong dropdown
  // chọn môn thi (khi chưa chọn Lớp thì hiện tất cả để không chặn luồng thao tác).
  const selectedFormClass = useMemo(
    () => classes.find((c) => String(c.ClassId) === form.classId) || null,
    [classes, form.classId]
  );
  const formSubjects = useMemo(
    () => (selectedFormClass ? subjects.filter((s) => s.MajorId === selectedFormClass.MajorId) : subjects),
    [subjects, selectedFormClass]
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const session = sessions.find((s) => s.SessionId === Number(form.sessionId));
    if (!session) {
      setError("Vui lòng chọn ca thi");
      return;
    }
    if (form.proctorIds.length < minProctors) {
      setError(`Cần tối thiểu ${minProctors} giám thị cho mỗi phòng thi`);
      return;
    }

    const payload = {
      semesterId: Number(form.semesterId),
      classId: Number(form.classId),
      subjectId: Number(form.subjectId),
      roomId: Number(form.roomId),
      proctorIds: form.proctorIds.map(Number),
      examDate: form.examDate,
      startTime: session.StartTime,
      endTime: session.EndTime,
      examType: form.examType,
      note: form.note,
    };
    try {
      const res = await axiosClient.post<{ warning?: string }>("/exams", payload);
      if (res.data.warning) alert(res.data.warning);
      setForm(emptyForm);
      loadExams();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      const conflict = axiosErr.response?.data?.conflict;
      let msg = axiosErr.response?.data?.message || "Có lỗi xảy ra";
      if (conflict?.roomConflicts?.length) msg += ` — Trùng phòng ${conflict.roomConflicts.length} lần`;
      if (conflict?.proctorConflicts?.length) msg += ` — Trùng giám thị ${conflict.proctorConflicts.length} lần`;
      setError(msg);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa ca thi này?")) return;
    await axiosClient.delete(`/exams/${id}`);
    loadExams();
  }

  return (
    <div>
      <h1>Lịch thi kết thúc môn học</h1>

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
          <option value="">{filters.classId ? "-- Tất cả đợt học --" : "-- Chọn lớp trước --"}</option>
          {semesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
        </select>
      </div>

      {isAdmin && (
        <form className="schedule-form" onSubmit={handleSubmit}>
          <h3>Xếp ca thi mới</h3>
          <div className="form-grid">
            <select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value, semesterId: "" })} required>
              <option value="">Lớp</option>
              {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
            </select>
            <select value={form.semesterId} onChange={(e) => setForm({ ...form, semesterId: e.target.value })}
              required disabled={!form.classId}>
              <option value="">{form.classId ? "Đợt học" : "-- Chọn lớp trước --"}</option>
              {formSemesters.map((s) => <option key={s.SemesterId} value={s.SemesterId}>{s.SemesterName}</option>)}
            </select>
            <select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })} required>
              <option value="">Môn thi</option>
              {formSubjects.map((s) => <option key={s.SubjectId} value={s.SubjectId}>{subjectLabel(s)}</option>)}
            </select>
            <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })} required>
              <option value="">Phòng thi</option>
              {rooms.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
            </select>
            <select value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value as ExamType })}>
              {EXAM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <div>
              <select multiple value={form.proctorIds}
                onChange={(e) => setForm({ ...form, proctorIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {teachers.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
              </select>
              <div className="hint mt-1">Cần chọn tối thiểu {minProctors} giám thị</div>
            </div>
            <input type="date" value={form.examDate}
              onChange={(e) => setForm({ ...form, examDate: e.target.value })} required />
            <select value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })} required>
              <option value="">Ca thi</option>
              {sessions.map((s) => (
                <option key={s.SessionId} value={s.SessionId}>{s.SessionName} ({s.StartTime}–{s.EndTime})</option>
              ))}
            </select>
            <input placeholder="Ghi chú" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <small>Giữ Ctrl (Windows) / Cmd (Mac) để chọn nhiều giám thị coi thi</small>
          <button type="submit">Thêm ca thi</button>
          {error && <div className="error-text">{error}</div>}
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Ngày</th><th>Giờ</th><th>Lớp</th><th>Môn thi</th><th>Phòng</th>
            <th>Hình thức</th><th>Giám thị</th><th>Trạng thái</th>{isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ExamId}>
              <td>{r.ExamDate?.slice(0, 10)}</td>
              <td>{r.StartTime}–{r.EndTime}</td>
              <td>{r.ClassName}</td>
              <td>{r.SubjectName}</td>
              <td>{r.RoomName}</td>
              <td>{EXAM_TYPES.find((t) => t.value === r.ExamType)?.label}</td>
              <td>{r.Proctors}</td>
              <td>{r.Status}</td>
              {isAdmin && <td><button onClick={() => handleDelete(r.ExamId)}>Xóa</button></td>}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={9}>Chưa có dữ liệu</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
