import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 pl-3.5 pr-2.5 py-2 rounded-lg text-sm no-underline border-l-2 transition-colors duration-150 ${
    isActive
      ? "bg-white/10 border-white text-white font-medium"
      : "border-transparent text-[#dce6f1] hover:bg-white/10 hover:text-white"
  }`;

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const initial = user?.username?.[0]?.toUpperCase() || "?";

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 bg-linear-to-b from-brand to-brand-dark text-white py-6 px-4 flex flex-col">
        <div className="flex items-center gap-2.5 px-1.5 mb-8">
          <div className="w-9 h-9 rounded-lg bg-white/15 flex items-center justify-center font-bold text-sm">
            TKB
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">TKB Hợp Lực</div>
            <div className="text-[11px] text-white/50 leading-tight">Y Dược Hợp Lực</div>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={navLinkClass}>Trang chủ</NavLink>
          <NavLink to="/schedule" className={navLinkClass}>Thời khóa biểu</NavLink>
          <NavLink to="/exams" className={navLinkClass}>Lịch thi</NavLink>
          {isAdmin && (
            <>
              <div className="mt-4 mb-1 pt-3 border-t border-white/10 text-[11px] uppercase tracking-wide text-white/45 px-3.5">
                Danh mục
              </div>
              <NavLink to="/danh-muc/khoa-hoc" className={navLinkClass}>Khóa học</NavLink>
              <NavLink to="/danh-muc/khoa" className={navLinkClass}>Khoa</NavLink>
              <NavLink to="/danh-muc/giao-vien" className={navLinkClass}>Giảng viên</NavLink>
              <NavLink to="/danh-muc/nganh" className={navLinkClass}>Ngành đào tạo</NavLink>
              <NavLink to="/danh-muc/mon-hoc" className={navLinkClass}>Môn học</NavLink>
              <NavLink to="/danh-muc/khung-chuong-trinh" className={navLinkClass}>Khung chương trình đào tạo</NavLink>
              <NavLink to="/danh-muc/lop" className={navLinkClass}>Lớp học</NavLink>
              <NavLink to="/danh-muc/phong" className={navLinkClass}>Phòng học</NavLink>
              <NavLink to="/danh-muc/hoc-ky" className={navLinkClass}>Học kỳ / Đợt học</NavLink>
              <NavLink to="/danh-muc/ca-hoc" className={navLinkClass}>Ca học</NavLink>
              <NavLink to="/danh-muc/lich-nghi" className={navLinkClass}>Lịch nghỉ</NavLink>
              <NavLink to="/danh-muc/chuc-vu" className={navLinkClass}>Chức vụ</NavLink>
              <NavLink to="/danh-muc/tai-khoan" className={navLinkClass}>Quản lý tài khoản</NavLink>

              <div className="mt-4 mb-1 pt-3 border-t border-white/10 text-[11px] uppercase tracking-wide text-white/45 px-3.5">
                Báo cáo
              </div>
              <NavLink to="/bao-cao/gio-day" className={navLinkClass}>Báo cáo giờ dạy</NavLink>
            </>
          )}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white px-6 py-3 flex justify-between items-center border-b border-gray-200 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center text-sm font-semibold">
              {initial}
            </div>
            <span className="text-sm text-gray-700">
              Xin chào, <b>{user?.username}</b>{" "}
              <span className="ml-1 inline-block px-2 py-0.5 rounded-full text-xs bg-brand-light text-brand font-medium">
                {user?.role === "Admin" ? "Quản trị viên" : "Giảng viên"}
              </span>
            </span>
          </div>
          <button
            onClick={logout}
            className="bg-transparent text-gray-600 border border-gray-300 hover:bg-gray-50 hover:opacity-100"
          >
            Đăng xuất
          </button>
        </header>
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
