import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Room, RoomType, RoomUnavailability, Faculty, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

const ROOM_TYPES: { value: RoomType; label: string }[] = [
  { value: "LyThuyet", label: "Lý thuyết" },
  { value: "ThucHanh", label: "Thực hành" },
  { value: "Labo", label: "Labo" },
  { value: "LamSang", label: "Lâm sàng" },
  { value: "SanBai", label: "Sân bãi" },
];

interface RoomForm {
  roomName: string;
  roomType: RoomType;
  capacity: string;
  facultyId: string;
}

const emptyForm: RoomForm = { roomName: "", roomType: "LyThuyet", capacity: "", facultyId: "" };

interface UnavailForm {
  roomId: string;
  dateFrom: string;
  dateTo: string;
  reason: string;
}

const emptyUnavailForm: UnavailForm = { roomId: "", dateFrom: "", dateTo: "", reason: "" };

export default function Rooms() {
  const [items, setItems] = useState<Room[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [form, setForm] = useState<RoomForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const [unavailItems, setUnavailItems] = useState<RoomUnavailability[]>([]);
  const [unavailForm, setUnavailForm] = useState<UnavailForm>(emptyUnavailForm);
  const [unavailError, setUnavailError] = useState("");

  async function load() {
    const [roomRes, unavailRes, facultyRes] = await Promise.all([
      axiosClient.get<Room[]>("/rooms"),
      axiosClient.get<RoomUnavailability[]>("/room-unavailability"),
      axiosClient.get<Faculty[]>("/faculties"),
    ]);
    setItems(roomRes.data);
    setUnavailItems(unavailRes.data);
    setFaculties(facultyRes.data);
  }
  useEffect(() => { load(); }, []);

  async function handleUnavailSubmit(e: FormEvent) {
    e.preventDefault();
    setUnavailError("");
    if (unavailForm.dateTo < unavailForm.dateFrom) {
      setUnavailError("Ngày kết thúc phải sau ngày bắt đầu");
      return;
    }
    try {
      await axiosClient.post("/room-unavailability", {
        roomId: Number(unavailForm.roomId),
        dateFrom: unavailForm.dateFrom,
        dateTo: unavailForm.dateTo,
        reason: unavailForm.reason || undefined,
      });
      setUnavailForm(emptyUnavailForm);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setUnavailError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  async function handleUnavailDelete(id: number) {
    if (!confirm("Xóa khai báo khóa phòng này?")) return;
    await axiosClient.delete(`/room-unavailability/${id}`);
    load();
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = {
      roomName: form.roomName,
      roomType: form.roomType,
      capacity: form.capacity ? Number(form.capacity) : undefined,
      facultyId: form.facultyId ? Number(form.facultyId) : undefined,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/rooms/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/rooms", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Room) {
    setEditingId(item.RoomId);
    setForm({
      roomName: item.RoomName,
      roomType: item.RoomType,
      capacity: item.Capacity ? String(item.Capacity) : "",
      facultyId: item.FacultyId ? String(item.FacultyId) : "",
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa phòng này?")) return;
    try {
      await axiosClient.delete(`/rooms/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Phòng học</h1>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên phòng" value={form.roomName}
          onChange={(e) => setForm({ ...form, roomName: e.target.value })} required />
        <select value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value as RoomType })}>
          {ROOM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input type="number" placeholder="Sức chứa" value={form.capacity}
          onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <select value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
          <option value="">-- Khoa (tùy chọn, cho phòng Thực hành/Lâm sàng) --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Tên phòng</th><th>Loại phòng</th><th>Sức chứa</th><th>Khoa</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.RoomId}>
              <td>{idx + 1}</td>
              <td>{it.RoomName}</td>
              <td>{ROOM_TYPES.find((t) => t.value === it.RoomType)?.label}</td>
              <td>{it.Capacity}</td>
              <td>{it.FacultyName || "—"}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.RoomId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6">Khóa phòng tạm thời (sự cố / bảo trì)</h2>
      <p className="hint">Trong khoảng ngày khóa, phòng sẽ không thể được chọn khi xếp lịch học/lịch thi.</p>
      <form className="inline-form" onSubmit={handleUnavailSubmit}>
        <select value={unavailForm.roomId} onChange={(e) => setUnavailForm({ ...unavailForm, roomId: e.target.value })} required>
          <option value="">-- Chọn phòng --</option>
          {items.map((r) => <option key={r.RoomId} value={r.RoomId}>{r.RoomName}</option>)}
        </select>
        <input type="date" value={unavailForm.dateFrom}
          onChange={(e) => setUnavailForm({ ...unavailForm, dateFrom: e.target.value })} required />
        <input type="date" value={unavailForm.dateTo}
          onChange={(e) => setUnavailForm({ ...unavailForm, dateTo: e.target.value })} required />
        <input placeholder="Lý do (vd hỏng điều hòa, bảo trì...)" value={unavailForm.reason}
          onChange={(e) => setUnavailForm({ ...unavailForm, reason: e.target.value })} />
        <button type="submit">Khóa phòng</button>
      </form>
      {unavailError && <div className="error-text">{unavailError}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Phòng</th><th>Từ ngày</th><th>Đến ngày</th><th>Lý do</th><th></th></tr></thead>
        <tbody>
          {unavailItems.map((it, idx) => (
            <tr key={it.UnavailabilityId}>
              <td>{idx + 1}</td>
              <td>{it.RoomName}</td>
              <td>{it.DateFrom?.slice(0, 10)}</td>
              <td>{it.DateTo?.slice(0, 10)}</td>
              <td>{it.Reason}</td>
              <td><button onClick={() => handleUnavailDelete(it.UnavailabilityId)}>Mở khóa</button></td>
            </tr>
          ))}
          {unavailItems.length === 0 && <tr><td colSpan={6}>Chưa có khai báo khóa phòng nào.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
