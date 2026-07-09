import { FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Cohort, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface CohortForm {
  cohortName: string;
  startYear: string;
  durationYears: string;
}

const emptyForm: CohortForm = { cohortName: "", startYear: "", durationYears: "3" };

export default function Cohorts() {
  const [items, setItems] = useState<Cohort[]>([]);
  const [form, setForm] = useState<CohortForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await axiosClient.get<Cohort[]>("/cohorts");
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
    const payload = {
      cohortName: form.cohortName,
      startYear: Number(form.startYear),
      durationYears: Number(form.durationYears),
    };
    try {
      if (editingId) {
        await axiosClient.put(`/cohorts/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/cohorts", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Cohort) {
    setEditingId(item.CohortId);
    setForm({
      cohortName: item.CohortName,
      startYear: String(item.StartYear),
      durationYears: String(item.DurationYears),
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa khóa học này?")) return;
    try {
      await axiosClient.delete(`/cohorts/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  return (
    <div>
      <h1>Quản lý Khóa học</h1>
      <p className="hint">Vd: Khóa K15, nhập học năm 2023, đào tạo 3 năm (ra trường dự kiến 2026).</p>
      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Tên khóa (vd K15)" value={form.cohortName}
          onChange={(e) => setForm({ ...form, cohortName: e.target.value })} required />
        <input type="number" placeholder="Năm nhập học" value={form.startYear}
          onChange={(e) => setForm({ ...form, startYear: e.target.value })} required />
        <input type="number" placeholder="Số năm đào tạo" value={form.durationYears}
          onChange={(e) => setForm({ ...form, durationYears: e.target.value })} required />
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead>
          <tr><th>#</th><th>Tên khóa</th><th>Năm nhập học</th><th>Số năm đào tạo</th><th>Dự kiến ra trường</th><th></th></tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.CohortId}>
              <td>{idx + 1}</td>
              <td>{it.CohortName}</td>
              <td>{it.StartYear}</td>
              <td>{it.DurationYears}</td>
              <td>{it.StartYear + it.DurationYears}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.CohortId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
