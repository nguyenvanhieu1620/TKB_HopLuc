import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import PrivateRoute from "./components/PrivateRoute";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import ScheduleGrid from "./pages/Schedule/ScheduleGrid";
import ExamList from "./pages/Exam/ExamList";
import Teachers from "./pages/DanhMuc/Teachers";
import Cohorts from "./pages/DanhMuc/Cohorts";
import Majors from "./pages/DanhMuc/Majors";
import Subjects from "./pages/DanhMuc/Subjects";
import Classes from "./pages/DanhMuc/Classes";
import Rooms from "./pages/DanhMuc/Rooms";
import Semesters from "./pages/DanhMuc/Semesters";
import Sessions from "./pages/DanhMuc/Sessions";
import Faculties from "./pages/DanhMuc/Faculties";
import CurriculumItems from "./pages/DanhMuc/CurriculumItems";
import Holidays from "./pages/DanhMuc/Holidays";
import Positions from "./pages/DanhMuc/Positions";
import Accounts from "./pages/DanhMuc/Accounts";
import TeachingHoursReport from "./pages/Report/TeachingHoursReport";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="schedule" element={<ScheduleGrid />} />
        <Route path="exams" element={<ExamList />} />

        <Route path="danh-muc/khoa-hoc" element={<PrivateRoute adminOnly><Cohorts /></PrivateRoute>} />
        <Route path="danh-muc/giao-vien" element={<PrivateRoute adminOnly><Teachers /></PrivateRoute>} />
        <Route path="danh-muc/nganh" element={<PrivateRoute adminOnly><Majors /></PrivateRoute>} />
        <Route path="danh-muc/mon-hoc" element={<PrivateRoute adminOnly><Subjects /></PrivateRoute>} />
        <Route path="danh-muc/lop" element={<PrivateRoute adminOnly><Classes /></PrivateRoute>} />
        <Route path="danh-muc/phong" element={<PrivateRoute adminOnly><Rooms /></PrivateRoute>} />
        <Route path="danh-muc/hoc-ky" element={<PrivateRoute adminOnly><Semesters /></PrivateRoute>} />
        <Route path="danh-muc/ca-hoc" element={<PrivateRoute adminOnly><Sessions /></PrivateRoute>} />
        <Route path="danh-muc/khoa" element={<PrivateRoute adminOnly><Faculties /></PrivateRoute>} />
        <Route path="danh-muc/khung-chuong-trinh" element={<PrivateRoute adminOnly><CurriculumItems /></PrivateRoute>} />
        <Route path="danh-muc/lich-nghi" element={<PrivateRoute adminOnly><Holidays /></PrivateRoute>} />
        <Route path="danh-muc/chuc-vu" element={<PrivateRoute adminOnly><Positions /></PrivateRoute>} />
        <Route path="danh-muc/tai-khoan" element={<PrivateRoute adminOnly><Accounts /></PrivateRoute>} />

        <Route path="bao-cao/gio-day" element={<PrivateRoute adminOnly><TeachingHoursReport /></PrivateRoute>} />
      </Route>
    </Routes>
  );
}
