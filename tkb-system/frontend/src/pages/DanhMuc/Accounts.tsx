import { FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Account, Teacher, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";

interface CreateForm {
  teacherId: string;
  username: string;
  password: string;
}
const emptyForm: CreateForm = { teacherId: "", username: "", password: "" };

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [error, setError] = useState("");
  const [resetTargetId, setResetTargetId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");

  async function load() {
    const [acc, tch] = await Promise.all([
      axiosClient.get<Account[]>("/accounts"),
      axiosClient.get<Teacher[]>("/teachers"),
    ]);
    setAccounts(acc.data);
    setTeachers(tch.data);
  }
  useEffect(() => { load(); }, []);

  const teachersWithoutAccount = useMemo(
    () => teachers.filter((t) => !accounts.some((a) => a.TeacherId === t.TeacherId)),
    [teachers, accounts]
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await axiosClient.post("/accounts", {
        teacherId: Number(form.teacherId),
        username: form.username,
        password: form.password,
      });
      setForm(emptyForm);
      setShowForm(false);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  async function handleToggleActive(id: number) {
    await axiosClient.put(`/accounts/${id}/toggle-active`);
    load();
  }

  async function handleResetPassword(id: number) {
    if (!newPassword || newPassword.length < 6) {
      alert("Mật khẩu mới cần tối thiểu 6 ký tự");
      return;
    }
    await axiosClient.put(`/accounts/${id}/reset-password`, { newPassword });
    setResetTargetId(null);
    setNewPassword("");
    alert("Đã đặt lại mật khẩu");
  }

  return (
    <div>
      <h1>Quản lý tài khoản</h1>
      <p className="hint">Tài khoản đăng nhập của giảng viên để xem thời khóa biểu/lịch thi được phân công.</p>

      <button type="button" onClick={() => { setShowForm((v) => !v); setError(""); }}>
        {showForm ? "Đóng form" : "+ Tạo tài khoản cho giảng viên"}
      </button>

      {showForm && (
        <form className="schedule-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <select value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })} required>
              <option value="">-- Chọn giảng viên chưa có tài khoản --</option>
              {teachersWithoutAccount.map((t) => (
                <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>
              ))}
            </select>
            <input placeholder="Tên đăng nhập" value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            <input type="password" placeholder="Mật khẩu ban đầu" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </div>
          <button type="submit">Tạo tài khoản</button>
          {error && <div className="error-text">{error}</div>}
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Tên đăng nhập</th><th>Giảng viên</th><th>Vai trò</th><th>Trạng thái</th>
            <th>Đăng nhập gần nhất</th><th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.UserId}>
              <td>{a.Username}</td>
              <td>{a.TeacherName || "—"}</td>
              <td>{a.Role === "Admin" ? "Quản trị viên" : "Giảng viên"}</td>
              <td>{a.IsActive ? "Đang hoạt động" : "Đã khóa"}</td>
              <td>{a.LastLoginAt ? a.LastLoginAt.slice(0, 10) : "Chưa đăng nhập"}</td>
              <td>
                <button onClick={() => handleToggleActive(a.UserId)}>{a.IsActive ? "Khóa" : "Mở khóa"}</button>{" "}
                {resetTargetId === a.UserId ? (
                  <span className="inline-form" style={{ display: "inline-flex", padding: 0, boxShadow: "none", border: "none", marginBottom: 0 }}>
                    <input type="password" placeholder="Mật khẩu mới" value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)} />
                    <button onClick={() => handleResetPassword(a.UserId)}>Lưu</button>
                    <button onClick={() => { setResetTargetId(null); setNewPassword(""); }}>Hủy</button>
                  </span>
                ) : (
                  <button onClick={() => { setResetTargetId(a.UserId); setNewPassword(""); }}>Đặt lại mật khẩu</button>
                )}
              </td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={6}>Chưa có tài khoản nào</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
