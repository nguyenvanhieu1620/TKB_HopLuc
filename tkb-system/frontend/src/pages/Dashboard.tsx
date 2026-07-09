import { useAuth } from "../context/AuthContext";

export default function Dashboard() {
  const { user, isAdmin } = useAuth();

  return (
    <div>
      <h1>Trang chủ</h1>
      <p>
        Chào mừng <b>{user?.username}</b> đến với hệ thống Quản lý Thời khóa biểu.
      </p>
      {isAdmin ? (
        <p>Bạn có quyền quản trị: xếp lịch học, xếp lịch thi, quản lý danh mục ở menu bên trái.</p>
      ) : (
        <p>Bạn có thể xem thời khóa biểu và lịch thi được phân công ở menu bên trái.</p>
      )}
    </div>
  );
}
