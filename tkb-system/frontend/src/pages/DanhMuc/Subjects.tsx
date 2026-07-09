import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Subject, Faculty, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface SubjectForm {
  subjectCode: string;
  subjectName: string;
  facultyId: string;
  credits: string;
  theoryHours: string;
  practiceHours: string;
  examHours: string;
}

const emptyForm: SubjectForm = {
  subjectCode: "", subjectName: "", facultyId: "", credits: "", theoryHours: "", practiceHours: "", examHours: "",
};

export default function Subjects() {
  const [items, setItems] = useState<Subject[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [form, setForm] = useState<SubjectForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const [subRes, facultyRes] = await Promise.all([
      axiosClient.get<Subject[]>("/subjects"),
      axiosClient.get<Faculty[]>("/faculties"),
    ]);
    setItems(subRes.data);
    setFaculties(facultyRes.data);
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
      subjectCode: form.subjectCode,
      subjectName: form.subjectName,
      facultyId: form.facultyId ? Number(form.facultyId) : undefined,
      credits: form.credits ? Number(form.credits) : undefined,
      theoryHours: Number(form.theoryHours) || 0,
      practiceHours: Number(form.practiceHours) || 0,
      examHours: Number(form.examHours) || 0,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/subjects/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/subjects", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Subject) {
    setEditingId(item.SubjectId);
    setForm({
      subjectCode: item.SubjectCode || "",
      subjectName: item.SubjectName,
      facultyId: item.FacultyId ? String(item.FacultyId) : "",
      credits: item.Credits != null ? String(item.Credits) : "",
      theoryHours: String(item.TheoryHours),
      practiceHours: String(item.PracticeHours),
      examHours: String(item.ExamHours),
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa môn học này?")) return;
    try {
      await axiosClient.delete(`/subjects/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Môn học</h1>
      <p className="hint">
        Môn học không gắn cứng với 1 ngành — để phân bổ môn theo từng ngành và kỳ học, vào mục
        "Khung chương trình đào tạo".
      </p>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Mã môn" value={form.subjectCode}
          onChange={(e) => setForm({ ...form, subjectCode: e.target.value })} />
        <input placeholder="Tên môn học" value={form.subjectName}
          onChange={(e) => setForm({ ...form, subjectName: e.target.value })} required />
        <select value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
          <option value="">-- Khoa phụ trách --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <input type="number" placeholder="Số tín chỉ" value={form.credits}
          onChange={(e) => setForm({ ...form, credits: e.target.value })} />
        <input type="number" placeholder="Giờ lý thuyết" value={form.theoryHours}
          onChange={(e) => setForm({ ...form, theoryHours: e.target.value })} />
        <input type="number" placeholder="Giờ thực hành" value={form.practiceHours}
          onChange={(e) => setForm({ ...form, practiceHours: e.target.value })} />
        <input type="number" placeholder="Giờ thi/kiểm tra" value={form.examHours}
          onChange={(e) => setForm({ ...form, examHours: e.target.value })} />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th><th>Mã môn</th><th>Tên môn</th><th>Khoa</th><th>Tín chỉ</th>
            <th>LT</th><th>TH</th><th>Thi</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.SubjectId}>
              <td>{idx + 1}</td>
              <td>{it.SubjectCode}</td>
              <td>{it.SubjectName}</td>
              <td>{it.FacultyName}</td>
              <td>{it.Credits}</td>
              <td>{it.TheoryHours}</td>
              <td>{it.PracticeHours}</td>
              <td>{it.ExamHours}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.SubjectId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
