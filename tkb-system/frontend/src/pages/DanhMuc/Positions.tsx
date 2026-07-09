import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Position, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

export default function Positions() {
  const [items, setItems] = useState<Position[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Position[]>("/positions");
    setItems(res.data);
  }
  useEffect(() => { load(); }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editingId) {
        await axiosClient.put(`/positions/${editingId}`, { positionName: name, isActive: true });
      } else {
        await axiosClient.post("/positions", { positionName: name });
      }
      setName("");
      setEditingId(null);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Position) {
    setEditingId(item.PositionId);
    setName(item.PositionName);
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa chức vụ này?")) return;
    try {
      await axiosClient.delete(`/positions/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Chức vụ</h1>
      <p className="hint">Danh mục chức vụ giảng viên (vd Trưởng khoa, Phó trưởng khoa, Giảng viên, Giáo vụ...).</p>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên chức vụ" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={() => { setEditingId(null); setName(""); }}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên chức vụ</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.PositionId}>
              <td>{idx + 1}</td>
              <td>{it.PositionName}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.PositionId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
