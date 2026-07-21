import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Subject, Faculty, Major, Room, BulkImportResult, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";
import { readWorkbook, sheetToRows, buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { normalizeText } from "../../../utils/text";

interface SubjectForm {
  subjectCode: string;
  subjectName: string;
  facultyId: string;
  majorId: string;
  credits: string;
  theoryHours: string;
  practiceHours: string;
  examHours: string;
  category: string;
  isActive: boolean;
  // Việc BT: môn Thực hành/Lâm sàng có CẦN chia nhóm theo bảng mốc sĩ số hay không — mặc định TICK
  // (true, đúng hành vi hiện tại) khi tạo mới. Bỏ tick khi cả lớp học chung 1 buổi không cần tách
  // nhóm (vd Giáo dục thể chất học ở sân bãi rộng).
  requiresGrouping: boolean;
  // Việc BR: Phòng Thực hành/Lâm sàng cụ thể phù hợp với môn này — rỗng = chưa cấu hình riêng (khi
  // xếp lịch sẽ cho chọn mọi phòng đúng loại RoomType như trước, xem checkSubjectRoom backend).
  roomIds: string[];
}

const emptyForm: SubjectForm = {
  subjectCode: "", subjectName: "", facultyId: "", majorId: "", credits: "", theoryHours: "", practiceHours: "", examHours: "",
  category: "", isActive: true, requiresGrouping: true, roomIds: [],
};

// Việc BR: chỉ các loại phòng liên quan Thực hành/Lâm sàng mới cần gán riêng — Lý thuyết không thuộc
// phạm vi tính năng này (checkSubjectRoom backend chỉ áp dụng khi sessionType === "Practice").
// Việc BU: bổ sung SanBai (Sân bãi) — dùng cho môn như Giáo dục thể chất (PracticeMode="LyThuyet" nên
// roomCategoryFor xếp phòng loại này chung nhóm LyThuyet/SanBai, xem policyRules.ts) — trước đây bị bỏ
// sót khỏi danh sách nên Admin không gán được Sân bãi riêng cho môn.
const PRACTICE_ROOM_TYPES = ["ThucHanh", "Labo", "LamSang", "SanBai"];
const ROOM_TYPE_LABEL: Record<string, string> = { ThucHanh: "Thực hành", Labo: "Labo", LamSang: "Lâm sàng", SanBai: "Sân bãi" };

// Phân loại môn theo khối kiến thức — dùng để ưu tiên thứ tự xử lý môn khi tự động xếp lịch (Đại
// cương xếp trước, rồi Cơ sở ngành, rồi Chuyên ngành). Mã nội bộ không dấu, nhãn tiếng Việt ở UI —
// cùng quy ước với PracticeMode (Việc BA).
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "DaiCuong", label: "Đại cương" },
  { value: "CoSoNganh", label: "Cơ sở ngành" },
  { value: "ChuyenNganh", label: "Chuyên ngành" },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

function parseCategory(raw: string): { value: string; error: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: "", error: false };
  const normalized = normalizeText(trimmed);
  const match = CATEGORY_OPTIONS.find((o) => normalizeText(o.label) === normalized);
  if (match) return { value: match.value, error: false };
  return { value: "", error: true };
}

interface ExcelSubjectRow {
  "Mã môn"?: string | number;
  "Tên môn"?: string;
  "Ngành"?: string;
  "Khoa"?: string;
  "Số tín chỉ"?: string | number;
  "Giờ lý thuyết"?: string | number;
  "Giờ thực hành"?: string | number;
  "Giờ thi/kiểm tra"?: string | number;
  "Phân loại"?: string;
}

interface ImportRow {
  rowNum: number;
  subjectCode: string;
  subjectName: string;
  majorRaw: string;
  majorId: number | null;
  facultyRaw: string;
  facultyId: number | null;
  credits: number | null;
  theoryHours: number;
  practiceHours: number;
  examHours: number;
  category: string;
  error: string | null;
  errorDetail?: string;
  selected: boolean;
}

// Việc AQ: mỗi Môn học gắn TRỰC TIẾP 1 Ngành, Mã môn bắt buộc + duy nhất toàn hệ thống — trùng
// TÊN giữa các Ngành khác nhau giờ là bình thường (không còn kiểm tra/hỏi gộp theo tên nữa).
function parseImportRow(raw: ExcelSubjectRow, rowNum: number, faculties: Faculty[], majors: Major[]): ImportRow {
  const subjectCode = String(raw["Mã môn"] ?? "").trim();
  const subjectName = String(raw["Tên môn"] ?? "").trim();
  const majorRaw = String(raw["Ngành"] ?? "").trim();
  const facultyRaw = String(raw["Khoa"] ?? "").trim();
  const creditsRaw = raw["Số tín chỉ"];
  const credits = creditsRaw !== undefined && creditsRaw !== "" ? Number(creditsRaw) : null;
  const theoryHours = Number(raw["Giờ lý thuyết"]) || 0;
  const practiceHours = Number(raw["Giờ thực hành"]) || 0;
  const examHours = Number(raw["Giờ thi/kiểm tra"]) || 0;
  const categoryRaw = String(raw["Phân loại"] ?? "").trim();
  const categoryParsed = parseCategory(categoryRaw);
  const category = categoryParsed.value;

  let error: string | null = null;
  let errorDetail: string | undefined;
  let facultyId: number | null = null;
  let majorId: number | null = null;

  if (!subjectName) error = "Thiếu tên môn học";
  if (!error && !subjectCode) error = "Thiếu mã môn";
  if (!error && categoryParsed.error) error = `Không nhận diện được "Phân loại" là "${categoryRaw}"`;

  if (!majorRaw) {
    if (!error) error = "Thiếu ngành";
  } else {
    const match = majors.find((m) => normalizeText(m.MajorName) === normalizeText(majorRaw));
    if (match) majorId = match.MajorId;
    else if (!error) {
      error = `Không tìm thấy ngành "${majorRaw}"`;
      errorDetail = `Các ngành hợp lệ trong hệ thống: ${majors.map((m) => m.MajorName).join(", ")}`;
    }
  }

  if (facultyRaw) {
    const match = faculties.find((f) => normalizeText(f.FacultyName) === normalizeText(facultyRaw));
    if (match) facultyId = match.FacultyId;
    else if (!error) {
      error = `Không tìm thấy khoa "${facultyRaw}"`;
      errorDetail = faculties.length > 0
        ? `Các khoa hợp lệ trong hệ thống: ${faculties.map((f) => f.FacultyName).join(", ")}`
        : "Hệ thống chưa có khoa nào — vào mục \"Khoa\" trong Danh mục để khai báo trước.";
    }
  }

  return {
    rowNum, subjectCode, subjectName, majorRaw, majorId, facultyRaw, facultyId,
    credits, theoryHours, practiceHours, examHours, category,
    error, errorDetail, selected: !error,
  };
}

export default function Subjects() {
  const [items, setItems] = useState<Subject[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [majors, setMajors] = useState<Major[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [form, setForm] = useState<SubjectForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "true" | "false">("");
  const [trainingModeFilter, setTrainingModeFilter] = useState("");
  const [majorFilter, setMajorFilter] = useState("");
  const [facultyFilter, setFacultyFilter] = useState("");
  // Việc BR: mặc định chỉ gợi ý phòng CÙNG Khoa với môn đang sửa cho dễ chọn — bật cờ này để hiện
  // thêm phòng ở Khoa khác (vẫn cho chọn tự do nếu cần).
  const [showAllFacultyRooms, setShowAllFacultyRooms] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [importResultDetails, setImportResultDetails] = useState<string[]>([]);

  async function loadLookups() {
    const [facultyRes, majorRes, roomRes] = await Promise.all([
      axiosClient.get<Faculty[]>("/faculties"),
      axiosClient.get<Major[]>("/majors"),
      axiosClient.get<Room[]>("/rooms"),
    ]);
    setFaculties(facultyRes.data);
    setMajors(majorRes.data);
    setRooms(roomRes.data);
  }
  useEffect(() => { loadLookups(); }, []);

  async function loadItems() {
    const params: Record<string, string> = {};
    if (facultyFilter) params.facultyId = facultyFilter;
    if (majorFilter) params.majorId = majorFilter;
    if (trainingModeFilter) params.trainingMode = trainingModeFilter;
    const res = await axiosClient.get<Subject[]>("/subjects", { params });
    setItems(res.data);
  }
  useEffect(() => { loadItems(); }, [facultyFilter, majorFilter, trainingModeFilter]);

  const filteredMajorsForFilter = useMemo(
    () => (trainingModeFilter ? majors.filter((m) => m.TrainingMode === trainingModeFilter) : majors),
    [majors, trainingModeFilter]
  );

  function handleTrainingModeFilterChange(value: string) {
    setTrainingModeFilter(value);
    if (majorFilter) {
      const stillValid = majors.some((m) => String(m.MajorId) === majorFilter && (!value || m.TrainingMode === value));
      if (!stillValid) setMajorFilter("");
    }
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setShowAllFacultyRooms(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.subjectCode.trim()) {
      setError("Vui lòng nhập mã môn");
      return;
    }
    if (!form.majorId) {
      setError("Vui lòng chọn ngành");
      return;
    }
    const payload = {
      subjectCode: form.subjectCode.trim(),
      subjectName: form.subjectName,
      facultyId: form.facultyId ? Number(form.facultyId) : undefined,
      majorId: Number(form.majorId),
      credits: form.credits ? Number(form.credits) : undefined,
      theoryHours: Number(form.theoryHours) || 0,
      practiceHours: Number(form.practiceHours) || 0,
      examHours: Number(form.examHours) || 0,
      category: form.category || undefined,
      isActive: form.isActive,
      requiresGrouping: form.requiresGrouping,
    };
    try {
      let subjectId = editingId;
      if (editingId) {
        await axiosClient.put(`/subjects/${editingId}`, payload);
      } else {
        const res = await axiosClient.post<{ subjectId: number }>("/subjects", payload);
        subjectId = res.data.subjectId;
      }
      // Việc BR: lưu danh sách Phòng Thực hành/Lâm sàng riêng cho môn (rỗng = xóa hết ràng buộc, quay
      // về lọc theo loại phòng chung như trước).
      await axiosClient.put(`/subjects/${subjectId}/rooms`, { roomIds: form.roomIds.map(Number) });
      resetForm();
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  async function handleEdit(item: Subject) {
    setEditingId(item.SubjectId);
    setShowAllFacultyRooms(false);
    const roomsRes = await axiosClient.get<{ RoomId: number }[]>(`/subjects/${item.SubjectId}/rooms`);
    setForm({
      subjectCode: item.SubjectCode || "",
      subjectName: item.SubjectName,
      facultyId: item.FacultyId ? String(item.FacultyId) : "",
      majorId: item.MajorId != null ? String(item.MajorId) : "",
      credits: item.Credits != null ? String(item.Credits) : "",
      theoryHours: String(item.TheoryHours),
      practiceHours: String(item.PracticeHours),
      examHours: String(item.ExamHours),
      category: item.Category || "",
      isActive: item.IsActive,
      requiresGrouping: item.RequiresGrouping,
      roomIds: roomsRes.data.map((r) => String(r.RoomId)),
    });
  }

  function toggleRoom(roomId: number) {
    const key = String(roomId);
    setForm((f) => ({
      ...f,
      roomIds: f.roomIds.includes(key) ? f.roomIds.filter((id) => id !== key) : [...f.roomIds, key],
    }));
  }

  // Việc BR: mặc định chỉ gợi ý phòng Thực hành/Lâm sàng CÙNG Khoa với môn (dễ chọn hơn khi danh sách
  // Phòng toàn trường dài) — luôn giữ lại phòng ĐÃ chọn dù khác Khoa, để không "mất" lựa chọn cũ khi
  // đổi Khoa phụ trách sau khi đã gán phòng.
  const pickableRooms = useMemo(() => {
    const relevant = rooms.filter((r) => r.IsActive && PRACTICE_ROOM_TYPES.includes(r.RoomType));
    if (showAllFacultyRooms || !form.facultyId) return relevant;
    return relevant.filter((r) => String(r.FacultyId) === form.facultyId || form.roomIds.includes(String(r.RoomId)));
  }, [rooms, form.facultyId, form.roomIds, showAllFacultyRooms]);

  async function handleDelete(id: number) {
    if (!confirm("Xóa môn học này?")) return;
    try {
      await axiosClient.delete(`/subjects/${id}`);
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  function downloadSampleTemplate() {
    const wb = buildWorkbook([{
      name: "Môn học",
      rows: [
        {
          "Mã môn": "D08",
          "Tên môn": "Toán cao cấp",
          "Ngành": majors[0]?.MajorName || "Ngành Dược chính quy",
          "Khoa": faculties[0]?.FacultyName || "Khoa Dược",
          "Số tín chỉ": 3,
          "Giờ lý thuyết": 30,
          "Giờ thực hành": 15,
          "Giờ thi/kiểm tra": 2,
          "Phân loại": "Đại cương",
        },
        {
          "Mã môn": "Y08",
          "Tên môn": "Toán cao cấp",
          "Ngành": majors[1]?.MajorName || "Ngành Y sỹ đa khoa",
          "Khoa": "",
          "Số tín chỉ": 3,
          "Giờ lý thuyết": 30,
          "Giờ thực hành": 15,
          "Giờ thi/kiểm tra": 2,
          "Phân loại": "Đại cương",
        },
      ],
    }]);
    downloadWorkbook(wb, "Mau_Import_MonHoc.xlsx");
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportResult(null);
    setImportResultDetails([]);
    const wb = await readWorkbook(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raws = sheetToRows<ExcelSubjectRow>(sheet);
    setImportRows(raws.map((r, idx) => parseImportRow(r, idx + 2, faculties, majors)));
  }

  function toggleRow(rowNum: number) {
    setImportRows((rows) => rows.map((r) => (r.rowNum === rowNum ? { ...r, selected: !r.selected } : r)));
  }

  function closeImport() {
    setShowImport(false);
    setImportRows([]);
    setImportResult(null);
    setImportResultDetails([]);
  }

  async function handleConfirmImport() {
    const selected = importRows.filter((r) => r.selected && !r.error);
    if (selected.length === 0) return;
    setImporting(true);
    try {
      const res = await axiosClient.post<BulkImportResult>("/subjects/bulk", {
        subjects: selected.map((r) => ({
          subjectCode: r.subjectCode,
          subjectName: r.subjectName,
          facultyId: r.facultyId ?? undefined,
          majorId: r.majorId ?? undefined,
          credits: r.credits ?? undefined,
          theoryHours: r.theoryHours,
          practiceHours: r.practiceHours,
          examHours: r.examHours,
          category: r.category || undefined,
        })),
      });
      setImportResult(res.data);
      setImportResultDetails((res.data.errors || []).map((e) => {
        const row = selected[e.index];
        return `Dòng ${row.rowNum} (${row.subjectCode} - ${row.subjectName}): ${e.message}`;
      }));
      setImportRows([]);
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi khi nhập dữ liệu");
    } finally {
      setImporting(false);
    }
  }

  const validCount = importRows.filter((r) => !r.error).length;
  const selectedCount = importRows.filter((r) => r.selected && !r.error).length;

  const filteredItems = useMemo(() => {
    if (statusFilter === "") return items;
    const wantActive = statusFilter === "true";
    return items.filter((s) => s.IsActive === wantActive);
  }, [items, statusFilter]);

  return (
    <div>
      <h1>Quản lý Môn học</h1>
      <p className="hint">
        Mỗi môn học gắn trực tiếp với 1 ngành cụ thể (mã môn bắt buộc, duy nhất toàn hệ thống) — có thể
        trùng tên giữa các ngành khác nhau. Để phân bổ môn vào từng kỳ học của ngành, vào mục
        "Khung chương trình đào tạo".
      </p>

      <div className="filter-bar">
        <select value={trainingModeFilter} onChange={(e) => handleTrainingModeFilterChange(e.target.value)}>
          <option value="">-- Tất cả hệ đào tạo --</option>
          <option value="CQ">Chính quy (CQ)</option>
          <option value="LT">Liên thông (LT)</option>
        </select>
        <select value={majorFilter} onChange={(e) => setMajorFilter(e.target.value)}>
          <option value="">-- Tất cả ngành --</option>
          {filteredMajorsForFilter.map((m) => <option key={m.MajorId} value={m.MajorId}>{m.MajorName}</option>)}
        </select>
        <select value={facultyFilter} onChange={(e) => setFacultyFilter(e.target.value)}>
          <option value="">-- Tất cả khoa --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | "true" | "false")}>
          <option value="">-- Tất cả trạng thái --</option>
          <option value="true">Đang sử dụng</option>
          <option value="false">Ngừng sử dụng</option>
        </select>
        <button type="button" onClick={() => setShowImport((v) => !v)}>
          {showImport ? "Đóng nhập Excel" : "Nhập từ Excel"}
        </button>
        <button type="button" onClick={downloadSampleTemplate}>Tải file mẫu</button>
      </div>

      {showImport && (
        <div className="inline-form items-start flex-col">
          <p className="hint">
            Mỗi dòng là 1 môn học gắn với đúng 1 Ngành (cột "Ngành", khớp theo tên đã chuẩn hóa) — Mã môn
            bắt buộc và phải duy nhất toàn hệ thống; trùng tên giữa các ngành khác nhau là bình thường,
            không bị chặn hay hỏi gộp. Dòng nào mã đã tồn tại sẽ báo lỗi rõ ràng, không tự tạo trùng.
          </p>
          <input type="file" accept=".xlsx,.xls" onChange={handleFile} />

          {importRows.length > 0 && (
            <>
              <p className="hint mt-2">
                {validCount}/{importRows.length} dòng hợp lệ — {selectedCount} dòng sẽ được nhập.
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th><th>Dòng</th><th>Mã môn</th><th>Tên môn</th><th>Ngành</th><th>Khoa</th>
                    <th>Tín chỉ</th><th>LT</th><th>TH</th><th>Thi</th><th>Phân loại</th><th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.map((r) => (
                    <tr key={r.rowNum}>
                      <td>
                        <input type="checkbox" checked={r.selected} disabled={!!r.error}
                          onChange={() => toggleRow(r.rowNum)} />
                      </td>
                      <td>{r.rowNum}</td>
                      <td>{r.subjectCode}</td>
                      <td>{r.subjectName}</td>
                      <td>{r.majorRaw}</td>
                      <td>{r.facultyRaw}</td>
                      <td>{r.credits}</td>
                      <td>{r.theoryHours}</td>
                      <td>{r.practiceHours}</td>
                      <td>{r.examHours}</td>
                      <td>{CATEGORY_LABEL[r.category] || "—"}</td>
                      <td>
                        {r.error
                          ? <span className="error-text mt-0" title={r.errorDetail}>{r.error}</span>
                          : <span className="text-green-600 text-[13px]">✓ Hợp lệ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-2 mt-3">
                <button type="button" disabled={selectedCount === 0 || importing} onClick={handleConfirmImport}>
                  {importing ? "Đang nhập..." : `Xác nhận nhập (${selectedCount})`}
                </button>
                <button type="button" onClick={closeImport}>Hủy</button>
              </div>
            </>
          )}

          {importResult && (
            <div className="mt-3">
              <p className="hint">
                Đã nhập thành công {importResult.successCount} dòng, lỗi {importResult.errorCount} dòng.
              </p>
              {importResultDetails.length > 0 && (
                <ul className="text-[13px] text-danger list-disc pl-5">
                  {importResultDetails.map((msg, i) => <li key={i}>{msg}</li>)}
                </ul>
              )}
              <button type="button" onClick={closeImport}>Đóng</button>
            </div>
          )}
        </div>
      )}

      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Mã môn" value={form.subjectCode}
          onChange={(e) => setForm({ ...form, subjectCode: e.target.value })} required />
        <input placeholder="Tên môn học" value={form.subjectName}
          onChange={(e) => setForm({ ...form, subjectName: e.target.value })} required />
        <select value={form.majorId} onChange={(e) => setForm({ ...form, majorId: e.target.value })} required>
          <option value="">-- Chọn ngành --</option>
          {majors.map((m) => <option key={m.MajorId} value={m.MajorId}>{m.MajorName}</option>)}
        </select>
        <select value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
          <option value="">-- Khoa phụ trách --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <input type="number" placeholder="Số tín chỉ" value={form.credits}
          onChange={(e) => setForm({ ...form, credits: e.target.value })} />
        <input type="number" placeholder="Giờ lý thuyết" value={form.theoryHours}
          onChange={(e) => setForm({ ...form, theoryHours: e.target.value })} />
        <input type="number" placeholder="Giờ thực hành" value={form.practiceHours}
          onChange={(e) => setForm({ ...form, practiceHours: e.target.value })} />
        <input type="number" placeholder="Giờ thi/kiểm tra" value={form.examHours}
          onChange={(e) => setForm({ ...form, examHours: e.target.value })} />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="">-- Chưa phân loại --</option>
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          Đang sử dụng
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.requiresGrouping}
            onChange={(e) => setForm({ ...form, requiresGrouping: e.target.checked })} />
          Cần chia nhóm khi Thực hành/Lâm sàng
        </label>

        <div className="w-full">
          <p className="hint mb-1">
            Phòng Thực hành/Lâm sàng/Sân bãi phù hợp với môn này (không bắt buộc) — nếu để trống, xếp
            lịch Thực hành/Lâm sàng cho môn này vẫn cho chọn mọi phòng đúng loại như trước. Nếu chọn ít
            nhất 1 phòng ở đây, xếp lịch (cả xếp tay lẫn tự động) cho môn này sẽ CHỈ được chọn trong đúng
            danh sách phòng đã chọn.
          </p>
          {form.facultyId && (
            <label className="flex items-center gap-2 text-[13px] mb-1">
              <input type="checkbox" checked={showAllFacultyRooms}
                onChange={(e) => setShowAllFacultyRooms(e.target.checked)} />
              Hiện cả phòng ở Khoa khác
            </label>
          )}
          <div className="subject-picker-list">
            {pickableRooms.length === 0 && <span className="hint">Không có phòng Thực hành/Lâm sàng/Sân bãi nào phù hợp.</span>}
            {pickableRooms.map((r) => (
              <label key={r.RoomId} className="flex items-center gap-2">
                <input type="checkbox" checked={form.roomIds.includes(String(r.RoomId))}
                  onChange={() => toggleRoom(r.RoomId)} />
                {r.RoomName} ({ROOM_TYPE_LABEL[r.RoomType] || r.RoomType})
              </label>
            ))}
          </div>
        </div>

        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th><th>Mã môn</th><th>Tên môn</th><th>Ngành</th><th>Khoa</th><th>Tín chỉ</th>
            <th>LT</th><th>TH</th><th>Thi</th><th>Phân loại</th><th>Chia nhóm</th><th>Trạng thái</th><th></th>
          </tr>
        </thead>
        <tbody>
          {filteredItems.map((it, idx) => (
            <tr key={it.SubjectId} className={it.IsActive ? "" : "opacity-50"}>
              <td>{idx + 1}</td>
              <td>{it.SubjectCode}</td>
              <td>{it.SubjectName}</td>
              <td>{it.MajorName}</td>
              <td>{it.FacultyName}</td>
              <td>{it.Credits}</td>
              <td>{it.TheoryHours}</td>
              <td>{it.PracticeHours}</td>
              <td>{it.ExamHours}</td>
              <td>{CATEGORY_LABEL[it.Category || ""] || "—"}</td>
              <td>{it.RequiresGrouping ? "Có" : "Không"}</td>
              <td>
                {it.IsActive
                  ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">Đang sử dụng</span>
                  : <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">Ngừng sử dụng</span>}
              </td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.SubjectId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
