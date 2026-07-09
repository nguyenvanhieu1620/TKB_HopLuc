import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { SchoolClass, Major, Cohort, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface ClassForm {
  className: string;
  majorId: string;
  cohortId: string;
  classSize: string;
  startDate: string;
}

const emptyForm: ClassForm = { className: "", majorId: "", cohortId: "", classSize: "", startDate: "" };

export default function Classes() {
  const [items, setItems] = useState<SchoolClass[]>([]);
  const [majors, setMajors] = useState<Major[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [form, setForm] = useState<ClassForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const [classRes, majorRes, cohortRes] = await Promise.all([
      axiosClient.get<SchoolClass[]>("/classes"),
      axiosClient.get<Major[]>("/majors"),
      axiosClient.get<Cohort[]>("/cohorts"),
    ]);
    setItems(classRes.data);
    setMajors(majorRes.data);
    setCohorts(cohortRes.data);
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = {
      className: form.className,
      majorId: Number(form.majorId),
      cohortId: Number(form.cohortId),
      classSize: Number(form.classSize) || 0,
      startDate: form.startDate || undefined,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/classes/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/classes", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: SchoolClass) {
    setEditingId(item.ClassId);
    setForm({
      className: item.ClassName,
      majorId: String(item.MajorId),
      cohortId: String(item.CohortId),
      classSize: String(item.ClassSize),
      startDate: item.StartDate ? item.StartDate.slice(0, 10) : "",
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa lớp này?")) return;
    try {
      await axiosClient.delete(`/classes/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  if (cohorts.length === 0 && items.length === 0) {
    return (
      <div>
        <h1>Quản lý Lớp học</h1>
        <p className="hint">Chưa có Khóa học nào. Vui lòng vào mục "Khóa học" để tạo trước khi thêm lớp.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Quản lý Lớp học</h1>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên lớp" value={form.className}
          onChange={(e) => setForm({ ...form, className: e.target.value })} required />
        <select value={form.majorId} onChange={(e) => setForm({ ...form, majorId: e.target.value })} required>
          <option value="">-- Chọn ngành --</option>
          {majors.map((m) => <option key={m.MajorId} value={m.MajorId}>{m.MajorName}</option>)}
        </select>
        <select value={form.cohortId} onChange={(e) => setForm({ ...form, cohortId: e.target.value })} required>
          <option value="">-- Chọn khóa học --</option>
          {cohorts.map((c) => <option key={c.CohortId} value={c.CohortId}>{c.CohortName}</option>)}
        </select>
        <input type="number" placeholder="Sĩ số" value={form.classSize}
          onChange={(e) => setForm({ ...form, classSize: e.target.value })} />
        <div>
          <label className="hint">Ngày khai giảng</label>
          <input type="date" value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </div>
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên lớp</th><th>Ngành</th><th>Hệ</th><th>Khóa</th><th>Sĩ số</th><th>Ngày khai giảng</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.ClassId}>
              <td>{idx + 1}</td>
              <td>{it.ClassName}</td>
              <td>{it.MajorName}</td>
              <td>{it.TrainingMode === "CQ" ? "Chính quy" : it.TrainingMode === "LT" ? "Liên thông" : "—"}</td>
              <td>{it.CohortName}</td>
              <td>{it.ClassSize}</td>
              <td>{it.StartDate ? it.StartDate.slice(0, 10) : "—"}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.ClassId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
