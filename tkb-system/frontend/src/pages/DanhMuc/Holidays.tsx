import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Holiday, HolidayAppliesTo, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

const APPLIES_TO_OPTIONS: { value: HolidayAppliesTo; label: string }[] = [
  { value: "ALL", label: "Tất cả" },
  { value: "CQ", label: "Chỉ hệ Chính quy" },
  { value: "LT", label: "Chỉ hệ Liên thông" },
];

interface HolidayForm {
  dateFrom: string;
  dateTo: string;
  description: string;
  appliesTo: HolidayAppliesTo;
}

const emptyForm: HolidayForm = { dateFrom: "", dateTo: "", description: "", appliesTo: "ALL" };

export default function Holidays() {
  const [items, setItems] = useState<Holiday[]>([]);
  const [form, setForm] = useState<HolidayForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Holiday[]>("/holidays");
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
    if (form.dateTo < form.dateFrom) {
      setError("Ngày kết thúc phải sau ngày bắt đầu");
      return;
    }
    try {
      if (editingId) {
        await axiosClient.put(`/holidays/${editingId}`, form);
      } else {
        await axiosClient.post("/holidays", form);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Holiday) {
    setEditingId(item.HolidayId);
    setForm({
      dateFrom: item.DateFrom?.slice(0, 10),
      dateTo: item.DateTo?.slice(0, 10),
      description: item.Description,
      appliesTo: item.AppliesTo || "ALL",
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa khoảng ngày nghỉ này?")) return;
    try {
      await axiosClient.delete(`/holidays/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  const sorted = [...items].sort((a, b) => a.DateFrom.localeCompare(b.DateFrom));

  return (
    <div>
      <h1>Quản lý Lịch nghỉ</h1>
      <p className="hint">
        Khai báo các khoảng ngày nghỉ lễ/nghỉ Tết — hệ thống sẽ cảnh báo (không chặn cứng) khi xếp lịch
        học/lịch thi rơi vào ngày nghỉ, để Admin tự quyết định (phòng trường hợp là lịch học bù). Hệ Liên
        thông không nghỉ hè nên có thể khai báo riêng để chỉ cảnh báo cho hệ Chính quy.
      </p>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input type="date" value={form.dateFrom}
          onChange={(e) => setForm({ ...form, dateFrom: e.target.value })} required />
        <input type="date" value={form.dateTo}
          onChange={(e) => setForm({ ...form, dateTo: e.target.value })} required />
        <input placeholder="Mô tả (vd Nghỉ Tết Nguyên đán 2026)" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} required />
        <select value={form.appliesTo} onChange={(e) => setForm({ ...form, appliesTo: e.target.value as HolidayAppliesTo })}>
          {APPLIES_TO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Từ ngày</th><th>Đến ngày</th><th>Mô tả</th><th>Áp dụng cho</th><th></th></tr></thead>
        <tbody>
          {sorted.map((it, idx) => (
            <tr key={it.HolidayId}>
              <td>{idx + 1}</td>
              <td>{it.DateFrom?.slice(0, 10)}</td>
              <td>{it.DateTo?.slice(0, 10)}</td>
              <td>{it.Description}</td>
              <td>{APPLIES_TO_OPTIONS.find((o) => o.value === it.AppliesTo)?.label || "Tất cả"}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.HolidayId)}>Xóa</button>
              </td>
            </tr>
          ))}
          {sorted.length === 0 && <tr><td colSpan={6}>Chưa có khai báo ngày nghỉ nào.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
