import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import axiosClient from "../api/axiosClient";
import { NotificationItem, NotificationListResponse } from "../types";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 pl-3.5 pr-2.5 py-2 rounded-lg text-sm no-underline border-l-2 transition-colors duration-150 ${
    isActive
      ? "bg-white/10 border-white text-white font-medium"
      : "border-transparent text-[#dce6f1] hover:bg-white/10 hover:text-white"
  }`;

const POLL_INTERVAL_MS = 60000;

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `${days} ngày trước`;
}

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const initial = user?.username?.[0]?.toUpperCase() || "?";

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showPanel, setShowPanel] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  async function loadNotifications() {
    const res = await axiosClient.get<NotificationListResponse>("/notifications");
    setNotifications(res.data.notifications);
    setUnreadCount(res.data.unreadCount);
  }

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleNotificationClick(n: NotificationItem) {
    if (!n.IsRead) {
      await axiosClient.put(`/notifications/${n.NotificationId}/read`);
      loadNotifications();
    }
    setShowPanel(false);
    if (n.RelatedType === "Schedule") navigate("/schedule");
    else if (n.RelatedType === "Exam") navigate("/exams");
  }

  async function handleMarkAllRead() {
    await axiosClient.put("/notifications/read-all");
    loadNotifications();
  }

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
          <div className="flex items-center gap-3">
            <div className="relative" ref={panelRef}>
              <button
                onClick={() => setShowPanel((v) => !v)}
                className="relative bg-transparent text-gray-600 border border-gray-300 hover:bg-gray-50 hover:opacity-100 px-2.5"
                title="Thông báo"
              >
                🔔
                {unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-4.5 h-4.5 px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center leading-none">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>

              {showPanel && (
                <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
                  <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-gray-100">
                    <span className="text-sm font-semibold text-gray-700">Thông báo</span>
                    {unreadCount > 0 && (
                      <button
                        onClick={handleMarkAllRead}
                        className="bg-transparent border-none text-brand text-xs px-0 py-0 hover:opacity-70"
                      >
                        Đánh dấu tất cả đã đọc
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 && (
                      <div className="px-3.5 py-4 text-sm text-gray-400 text-center">Chưa có thông báo nào</div>
                    )}
                    {notifications.map((n) => (
                      <div
                        key={n.NotificationId}
                        onClick={() => handleNotificationClick(n)}
                        className={`px-3.5 py-2.5 border-b border-gray-50 cursor-pointer text-sm hover:bg-gray-50 ${
                          n.IsRead ? "text-gray-500" : "bg-brand-light/30 text-gray-800 font-medium"
                        }`}
                      >
                        <div>{n.Content}</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">{relativeTime(n.CreatedAt)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={logout}
              className="bg-transparent text-gray-600 border border-gray-300 hover:bg-gray-50 hover:opacity-100"
            >
              Đăng xuất
            </button>
          </div>
        </header>
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
