import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Faculty, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

export default function Faculties() {
  const [items, setItems] = useState<Faculty[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Faculty[]>("/faculties");
    setItems(res.data);
  }
  useEffect(() => { load(); }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editingId) {
        await axiosClient.put(`/faculties/${editingId}`, { facultyName: name, isActive: true });
      } else {
        await axiosClient.post("/faculties", { facultyName: name });
      }
      setName("");
      setEditingId(null);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Faculty) {
    setEditingId(item.FacultyId);
    setName(item.FacultyName);
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa khoa này?")) return;
    try {
      await axiosClient.delete(`/faculties/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Khoa</h1>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên khoa" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={() => { setEditingId(null); setName(""); }}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên khoa</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.FacultyId}>
              <td>{idx + 1}</td>
              <td>{it.FacultyName}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.FacultyId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
