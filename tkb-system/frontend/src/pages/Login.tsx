import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiErrorResponse } from "../types";
import { AxiosError } from "axios";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      navigate("/");
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen">
      <div className="hidden md:flex flex-col justify-between w-2/5 max-w-md bg-linear-to-br from-brand to-brand-dark text-white p-10 relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/5" />
        <div className="absolute bottom-10 -left-10 w-40 h-40 rounded-full bg-white/5" />

        <div className="relative flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-lg bg-white/15 flex items-center justify-center font-bold text-sm">
            TKB
          </div>
          <span className="font-semibold">TKB Hợp Lực</span>
        </div>

        <div className="relative">
          <h1 className="text-2xl font-semibold leading-snug mb-3">
            Hệ thống Quản lý<br />Thời khóa biểu
          </h1>
          <p className="text-sm text-white/70 leading-relaxed">
            Trường Cao đẳng Y Dược Hợp Lực — xếp lịch học, lịch thi và quản lý danh mục đào tạo tập trung một nơi.
          </p>
        </div>

        <p className="relative text-xs text-white/40">© {new Date().getFullYear()} Trường Cao đẳng Y Dược Hợp Lực</p>
      </div>

      <div className="flex-1 flex items-center justify-center bg-page p-6">
        <form
          className="bg-white p-8 rounded-2xl shadow-xl border border-gray-100 w-full max-w-sm flex flex-col"
          onSubmit={handleSubmit}
        >
          <div className="w-11 h-11 rounded-xl bg-brand-light text-brand flex items-center justify-center font-bold mb-4 md:hidden">
            TKB
          </div>
          <h2 className="m-0 mb-1 text-lg font-semibold text-brand">Đăng nhập hệ thống</h2>
          <p className="m-0 mb-6 text-[13px] text-gray-500">Vui lòng đăng nhập để tiếp tục</p>

          <label className="text-[13px] font-medium text-gray-700 mb-1">Tên đăng nhập</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />

          <label className="text-[13px] font-medium text-gray-700 mt-3.5 mb-1">Mật khẩu</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

          {error && <div className="error-text">{error}</div>}

          <button type="submit" disabled={loading} className="mt-5 py-2.5">
            {loading ? "Đang đăng nhập..." : "Đăng nhập"}
          </button>
        </form>
      </div>
    </div>
  );
}
