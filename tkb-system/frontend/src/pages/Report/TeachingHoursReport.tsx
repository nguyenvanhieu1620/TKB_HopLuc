import { useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { TeachingHoursReportRow } from "../../types";

const CURRENT_YEAR = new Date().getFullYear();

export default function TeachingHoursReport() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [rows, setRows] = useState<TeachingHoursReportRow[]>([]);

  async function load() {
    const res = await axiosClient.get<TeachingHoursReportRow[]>("/reports/teaching-hours", { params: { year } });
    setRows(res.data);
  }
  useEffect(() => { load(); }, [year]);

  function statusLabel(r: TeachingHoursReportRow) {
    if (r.isOverLimit) return "Vượt định mức";
    if (r.percentUsed > 90) return "Gần vượt định mức";
    return "Bình thường";
  }

  function rowClass(r: TeachingHoursReportRow) {
    if (r.isOverLimit) return "row-danger";
    if (r.percentUsed > 90) return "row-warning";
    return "";
  }

  return (
    <div>
      <h1>Báo cáo giờ dạy</h1>
      <p className="hint">Tổng số giờ chuẩn đã xếp lịch dạy trong năm, so với định mức giờ dạy theo chức vụ.</p>

      <div className="filter-bar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - 2 + i).map((y) => (
            <option key={y} value={y}>Năm {y}</option>
          ))}
        </select>
      </div>

      <table className="data-table">
        <thead>
          <tr><th>Giảng viên</th><th>Giờ đã dạy</th><th>Định mức/năm</th><th>% đã dùng</th><th>Trạng thái</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.teacherId} className={rowClass(r)}>
              <td>{r.fullName}</td>
              <td>{r.totalHours}</td>
              <td>{r.maxHours}</td>
              <td>{r.percentUsed}%</td>
              <td>{statusLabel(r)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5}>Chưa có dữ liệu</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
