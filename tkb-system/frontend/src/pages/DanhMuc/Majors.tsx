import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Major, Faculty, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

export default function Majors() {
  const [items, setItems] = useState<Major[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [name, setName] = useState("");
  const [trainingMode, setTrainingMode] = useState("");
  const [facultyId, setFacultyId] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const [majorRes, facultyRes] = await Promise.all([
      axiosClient.get<Major[]>("/majors"),
      axiosClient.get<Faculty[]>("/faculties"),
    ]);
    setItems(majorRes.data);
    setFaculties(facultyRes.data);
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setTrainingMode("");
    setFacultyId("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = { majorName: name, trainingMode, facultyId: facultyId ? Number(facultyId) : undefined };
    try {
      if (editingId) {
        await axiosClient.put(`/majors/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/majors", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Major) {
    setEditingId(item.MajorId);
    setName(item.MajorName);
    setTrainingMode(item.TrainingMode || "");
    setFacultyId(item.FacultyId ? String(item.FacultyId) : "");
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa ngành này?")) return;
    try {
      await axiosClient.delete(`/majors/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Ngành đào tạo</h1>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên ngành" value={name} onChange={(e) => setName(e.target.value)} required />
        <select value={trainingMode} onChange={(e) => setTrainingMode(e.target.value)} required>
          <option value="">-- Chọn hệ đào tạo --</option>
          <option value="CQ">Chính quy</option>
          <option value="LT">Liên thông</option>
        </select>
        <select value={facultyId} onChange={(e) => setFacultyId(e.target.value)} required>
          <option value="">-- Chọn khoa quản lý --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên ngành</th><th>Hệ đào tạo</th><th>Khoa quản lý</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.MajorId}>
              <td>{idx + 1}</td>
              <td>{it.MajorName}</td>
              <td>{it.TrainingMode === "CQ" ? "Chính quy" : it.TrainingMode === "LT" ? "Liên thông" : "—"}</td>
              <td>{it.FacultyName || "—"}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.MajorId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
