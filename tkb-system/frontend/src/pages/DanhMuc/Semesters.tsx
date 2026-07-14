import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Semester, SchoolClass, GeneratedTerm, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface SemesterForm {
  semesterName: string;
  academicYear: string;
  startDate: string;
  endDate: string;
  teachingEndDate: string;
  termNumber: string;
}

const emptyForm: SemesterForm = {
  semesterName: "", academicYear: "", startDate: "", endDate: "", teachingEndDate: "", termNumber: "",
};

export default function Semesters() {
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classId, setClassId] = useState("");
  const [items, setItems] = useState<Semester[]>([]);
  const [form, setForm] = useState<SemesterForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");

  async function loadClasses() {
    const res = await axiosClient.get<SchoolClass[]>("/classes");
    setClasses(res.data);
  }
  useEffect(() => { loadClasses(); }, []);

  async function loadItems() {
    if (!classId) {
      setItems([]);
      return;
    }
    const res = await axiosClient.get<Semester[]>("/semesters", { params: { classId } });
    setItems(res.data);
  }
  useEffect(() => { loadItems(); }, [classId]);

  const selectedClass = classes.find((c) => String(c.ClassId) === classId) || null;

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  function handleClassChange(value: string) {
    setClassId(value);
    resetForm();
    setGenerateError("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = {
      semesterName: form.semesterName,
      academicYear: form.academicYear,
      startDate: form.startDate,
      endDate: form.endDate,
      teachingEndDate: form.teachingEndDate || null,
      classId: Number(classId),
      termNumber: form.termNumber ? Number(form.termNumber) : undefined,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/semesters/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/semesters", payload);
      }
      resetForm();
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Semester) {
    setEditingId(item.SemesterId);
    setForm({
      semesterName: item.SemesterName,
      academicYear: item.AcademicYear,
      startDate: item.StartDate?.slice(0, 10),
      endDate: item.EndDate?.slice(0, 10),
      teachingEndDate: item.TeachingEndDate ? item.TeachingEndDate.slice(0, 10) : "",
      termNumber: item.TermNumber != null ? String(item.TermNumber) : "",
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa kỳ học này?")) return;
    try {
      await axiosClient.delete(`/semesters/${id}`);
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  async function handleGenerateTerms(force: boolean) {
    if (!classId) return;
    if (force && !confirm("Xóa hết các Kỳ hiện có của lớp này và tạo lại từ đầu?")) return;
    setGenerateError("");
    setGenerating(true);
    try {
      const res = await axiosClient.post<{ terms: GeneratedTerm[] }>(`/classes/${classId}/generate-terms`, { force });
      alert(`Đã tạo ${res.data.terms.length} kỳ học cho lớp ${selectedClass?.ClassName ?? ""}`);
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setGenerateError(axiosErr.response?.data?.message || "Có lỗi khi tạo Kỳ học");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      <h1>Quản lý Học kỳ / Đợt học</h1>
      <p className="hint">
        Mỗi lớp học tuyển sinh vào thời điểm khác nhau nên có bộ Kỳ học riêng, tính theo đúng ngày khai giảng của lớp đó.
      </p>

      <div className="filter-bar">
        <select value={classId} onChange={(e) => handleClassChange(e.target.value)}>
          <option value="">-- Chọn lớp để xem/quản lý Kỳ học --</option>
          {classes.map((c) => <option key={c.ClassId} value={c.ClassId}>{c.ClassName}</option>)}
        </select>
      </div>

      {classId && selectedClass && !selectedClass.StartDate && (
        <p className="error-text">
          Lớp {selectedClass.ClassName} chưa có ngày khai giảng — vào mục "Lớp học" để cập nhật trước khi tạo Kỳ học.
        </p>
      )}

      {classId && selectedClass?.StartDate && (
        <div className="inline-form">
          {items.length === 0 ? (
            <button type="button" disabled={generating} onClick={() => handleGenerateTerms(false)}>
              {generating ? "Đang tạo..." : "Tự động tạo các Kỳ"}
            </button>
          ) : (
            <button type="button" disabled={generating} onClick={() => handleGenerateTerms(true)}>
              {generating ? "Đang tạo..." : "Xóa hết và tạo lại"}
            </button>
          )}
          {generateError && <span className="error-text mt-0">{generateError}</span>}
        </div>
      )}

      {classId && (
        <form className="inline-form" onSubmit={handleSubmit}>
          <input placeholder="Tên đợt học" value={form.semesterName}
            onChange={(e) => setForm({ ...form, semesterName: e.target.value })} required />
          <input placeholder="Năm học (vd 2025-2026)" value={form.academicYear}
            onChange={(e) => setForm({ ...form, academicYear: e.target.value })} required />
          <input type="date" value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
          <input type="date" value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
          <div>
            <input type="date" value={form.teachingEndDate}
              onChange={(e) => setForm({ ...form, teachingEndDate: e.target.value })} />
            <div className="hint mt-1">Hạn xếp tiết học (để trống = không giới hạn)</div>
          </div>
          <input type="number" placeholder="Kỳ thứ mấy" min={1} value={form.termNumber}
            onChange={(e) => setForm({ ...form, termNumber: e.target.value })} />
          <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
          {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
        </form>
      )}
      {error && <div className="error-text">{error}</div>}

      {!classId && <p className="hint">Vui lòng chọn 1 lớp ở trên để xem danh sách Kỳ học.</p>}

      {classId && items.length === 0 && selectedClass?.StartDate && (
        <p className="hint">Lớp này chưa có Kỳ học nào — bấm "Tự động tạo các Kỳ" ở trên.</p>
      )}

      {classId && items.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Kỳ</th><th>Tên đợt học</th><th>Năm học</th><th>Bắt đầu</th><th>Kết thúc</th><th>Hạn xếp tiết học</th><th></th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.SemesterId}>
                <td>{it.TermNumber ?? "—"}</td>
                <td>{it.SemesterName}</td>
                <td>{it.AcademicYear}</td>
                <td>{it.StartDate?.slice(0, 10)}</td>
                <td>{it.EndDate?.slice(0, 10)}</td>
                <td>{it.TeachingEndDate ? it.TeachingEndDate.slice(0, 10) : "—"}</td>
                <td>
                  <button onClick={() => handleEdit(it)}>Sửa</button>
                  <button onClick={() => handleDelete(it.SemesterId)}>Xóa</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
