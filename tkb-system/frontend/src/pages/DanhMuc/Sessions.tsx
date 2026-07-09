import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Session, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface SessionForm {
  sessionName: string;
  startTime: string;
  endTime: string;
  sortOrder: string;
}

const emptyForm: SessionForm = { sessionName: "", startTime: "", endTime: "", sortOrder: "" };

export default function Sessions() {
  const [items, setItems] = useState<Session[]>([]);
  const [form, setForm] = useState<SessionForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Session[]>("/sessions");
    setItems(res.data.sort((a, b) => a.SortOrder - b.SortOrder));
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setError("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = {
      sessionName: form.sessionName,
      startTime: form.startTime,
      endTime: form.endTime,
      sortOrder: form.sortOrder ? Number(form.sortOrder) : undefined,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/sessions/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/sessions", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Session) {
    setEditingId(item.SessionId);
    setForm({
      sessionName: item.SessionName,
      startTime: item.StartTime,
      endTime: item.EndTime,
      sortOrder: String(item.SortOrder),
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa ca học này?")) return;
    try {
      await axiosClient.delete(`/sessions/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Ca học</h1>
      <p className="hint">Xếp lịch theo ca (Sáng/Chiều/Tối...) thay vì theo tiết — có thể thêm, xóa, chỉnh giờ từng ca.</p>

      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên ca (vd Sáng)" value={form.sessionName}
          onChange={(e) => setForm({ ...form, sessionName: e.target.value })} required />
        <input type="time" value={form.startTime}
          onChange={(e) => setForm({ ...form, startTime: e.target.value })} required />
        <input type="time" value={form.endTime}
          onChange={(e) => setForm({ ...form, endTime: e.target.value })} required />
        <input type="number" placeholder="Thứ tự (để trống = tự động)" value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead>
          <tr><th>#</th><th>Tên ca</th><th>Giờ bắt đầu</th><th>Giờ kết thúc</th><th>Thứ tự</th><th></th></tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.SessionId}>
              <td>{idx + 1}</td>
              <td>{it.SessionName}</td>
              <td>{it.StartTime}</td>
              <td>{it.EndTime}</td>
              <td>{it.SortOrder}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.SessionId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <p className="hint">Chưa có ca học nào.</p>}
    </div>
  );
}
