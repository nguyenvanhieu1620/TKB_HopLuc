import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Semester, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface SemesterForm {
  semesterName: string;
  academicYear: string;
  startDate: string;
  endDate: string;
}

const emptyForm: SemesterForm = { semesterName: "", academicYear: "", startDate: "", endDate: "" };

export default function Semesters() {
  const [items, setItems] = useState<Semester[]>([]);
  const [form, setForm] = useState<SemesterForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Semester[]>("/semesters");
    setItems(res.data);
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editingId) {
        await axiosClient.put(`/semesters/${editingId}`, { ...form, isActive: true });
      } else {
        await axiosClient.post("/semesters", form);
      }
      resetForm();
      load();
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
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa đợt học này?")) return;
    try {
      await axiosClient.delete(`/semesters/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Học kỳ / Đợt học</h1>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên đợt học" value={form.semesterName}
          onChange={(e) => setForm({ ...form, semesterName: e.target.value })} required />
        <input placeholder="Năm học (vd 2025-2026)" value={form.academicYear}
          onChange={(e) => setForm({ ...form, academicYear: e.target.value })} required />
        <input type="date" value={form.startDate}
          onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
        <input type="date" value={form.endDate}
          onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên đợt học</th><th>Năm học</th><th>Bắt đầu</th><th>Kết thúc</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.SemesterId}>
              <td>{idx + 1}</td>
              <td>{it.SemesterName}</td>
              <td>{it.AcademicYear}</td>
              <td>{it.StartDate?.slice(0, 10)}</td>
              <td>{it.EndDate?.slice(0, 10)}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.SemesterId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
