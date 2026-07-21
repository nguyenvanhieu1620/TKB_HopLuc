import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { CurriculumItem, Major, Subject, Cohort, BulkImportResult, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";
import { readWorkbook, sheetToRows, buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { normalizeText, subjectLabel } from "../../../utils/text";

interface ItemForm {
  subjectId: string;
  termNumber: string;
  credits: string;
  totalHours: string;
  theoryHours: string;
  practiceHours: string;
  examHours: string;
  cohortId: string;
  sortOrder: string;
  practiceMode: string;
}

const emptyForm: ItemForm = {
  subjectId: "", termNumber: "1", credits: "",
  totalHours: "", theoryHours: "", practiceHours: "", examHours: "", cohortId: "", sortOrder: "",
  practiceMode: "ThucHanh",
};

// Việc BA: hình thức dạy phần Thực hành của môn — ảnh hưởng loại phòng được chọn và cách tính
// tiến độ (Lý thuyết/Thực hành) khi xếp lịch (xem ScheduleGrid.tsx).
// Việc BW: thêm SanBai (Sân bãi, vd Giáo dục thể chất) — trước đó phải dùng tạm LyThuyet vì thiếu
// giá trị riêng, khiến hệ thống tìm sai loại phòng (phòng thực hành lab thay vì sân bãi ngoài trời).
const PRACTICE_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "ThucHanh", label: "Học tại phòng Thực hành" },
  { value: "LyThuyet", label: "Học như Lý thuyết (dạy tại phòng Lý thuyết)" },
  { value: "LamSang", label: "Lâm sàng tại bệnh viện" },
  { value: "SanBai", label: "Sân bãi (GDTC...)" },
];

const PRACTICE_MODE_LABEL: Record<string, string> = {
  ThucHanh: "Thực hành",
  LyThuyet: "Học như LT",
  LamSang: "Lâm sàng",
  SanBai: "Sân bãi",
};

function parsePracticeMode(raw: string): { value: string; error: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: "ThucHanh", error: false };
  const normalized = normalizeText(trimmed);
  if (normalized === "thuc hanh") return { value: "ThucHanh", error: false };
  if (normalized === "ly thuyet") return { value: "LyThuyet", error: false };
  if (normalized === "lam sang") return { value: "LamSang", error: false };
  if (normalized === "san bai") return { value: "SanBai", error: false };
  return { value: "ThucHanh", error: true };
}

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function romanToNumber(roman: string): number | null {
  const s = roman.trim().toUpperCase();
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN_VALUES[s[i]];
    const next = ROMAN_VALUES[s[i + 1]];
    if (next && cur < next) total -= cur;
    else total += cur;
  }
  return total > 0 ? total : null;
}

function parseTermNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber) && asNumber > 0) return Math.floor(asNumber);
  return romanToNumber(trimmed);
}

interface ExcelCurriculumRow {
  "Mã MĐ"?: string | number;
  "Tên mô-đun"?: string;
  "Số tín chỉ"?: string | number;
  "Tổng số giờ"?: string | number;
  "Giờ lý thuyết"?: string | number;
  "Giờ thực hành"?: string | number;
  "Giờ thi/kiểm tra"?: string | number;
  "Kỳ"?: string | number;
  "Hình thức TH"?: string;
}

interface ImportRow {
  key: string;
  sheetName: string;
  rowNum: number;
  majorId: number | null;
  subjectCode: string;
  subjectName: string;
  credits: number | null;
  totalHours: number;
  theoryHours: number;
  practiceHours: number;
  examHours: number;
  termRaw: string;
  termNumber: number | null;
  practiceMode: string;
  error: string | null;
  selected: boolean;
  duplicateOf: Subject | null;
  resolution: "use-existing" | "create-new";
  newName: string;
}

function parseSheetRows(sheetName: string, raws: ExcelCurriculumRow[], majors: Major[], existingSubjects: Subject[]): ImportRow[] {
  const major = majors.find((m) => m.MajorName.trim().toLowerCase() === sheetName.trim().toLowerCase());
  return raws.map((raw, idx) => {
    const rowNum = idx + 2;
    const subjectCode = String(raw["Mã MĐ"] ?? "").trim();
    const subjectName = String(raw["Tên mô-đun"] ?? "").trim();
    const creditsRaw = raw["Số tín chỉ"];
    const credits = creditsRaw !== undefined && creditsRaw !== "" ? Number(creditsRaw) : null;
    const totalHours = Number(raw["Tổng số giờ"]) || 0;
    const theoryHours = Number(raw["Giờ lý thuyết"]) || 0;
    const practiceHours = Number(raw["Giờ thực hành"]) || 0;
    const examHours = Number(raw["Giờ thi/kiểm tra"]) || 0;
    const termRaw = String(raw["Kỳ"] ?? "").trim();
    const termNumber = parseTermNumber(termRaw);
    const practiceModeRaw = String(raw["Hình thức TH"] ?? "").trim();
    const practiceModeParsed = parsePracticeMode(practiceModeRaw);

    let error: string | null = null;
    if (!major) error = `Không tìm thấy ngành "${sheetName}"`;
    else if (!subjectCode) error = "Thiếu mã mô-đun";
    else if (!subjectName) error = "Thiếu tên mô-đun";
    else if (!termNumber) error = `Không đọc được kỳ học "${termRaw}"`;
    else if (practiceModeParsed.error) error = `Không đọc được "Hình thức TH" là "${practiceModeRaw}"`;

    const duplicateOf = subjectName
      ? existingSubjects.find((s) => normalizeText(s.SubjectName) === normalizeText(subjectName)) || null
      : null;
    const newName = duplicateOf ? `${subjectName} (${sheetName})` : subjectName;

    return {
      key: `${sheetName}__${rowNum}`, sheetName, rowNum,
      majorId: major?.MajorId ?? null,
      subjectCode, subjectName, credits, totalHours, theoryHours, practiceHours, examHours,
      termRaw, termNumber, practiceMode: practiceModeParsed.value, error, selected: !error,
      duplicateOf, resolution: "use-existing", newName,
    };
  });
}

// Dòng chọn "Đây là môn khác, tạo mới" mà tên vẫn trùng (hoặc bỏ trống) — chưa thể nhập được.
function isUnresolvedDuplicate(row: ImportRow, existingSubjects: Subject[]): boolean {
  if (row.resolution !== "create-new") return false;
  const trimmed = row.newName.trim();
  if (!trimmed) return true;
  return existingSubjects.some((s) => normalizeText(s.SubjectName) === normalizeText(trimmed));
}

export default function CurriculumItems() {
  const [majors, setMajors] = useState<Major[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [trainingModeFilter, setTrainingModeFilter] = useState("");
  const [cohortFilter, setCohortFilter] = useState("");
  const [majorId, setMajorId] = useState("");
  const [items, setItems] = useState<CurriculumItem[]>([]);
  const [form, setForm] = useState<ItemForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const [showImport, setShowImport] = useState(false);
  const [importCohortId, setImportCohortId] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [importResultDetails, setImportResultDetails] = useState<string[]>([]);

  // Môn "Ngừng sử dụng" bị ẩn khỏi dropdown "thêm mới", nhưng nếu dòng đang sửa dùng đúng môn đó
  // (kể cả đã ngừng dùng) vẫn phải hiện, không được làm mất lựa chọn cũ. Danh sách subjects đầy đủ
  // (không lọc) vẫn cần giữ nguyên cho việc so trùng tên khi Import Excel.
  // Việc AR: ưu tiên sắp xếp lên đầu các môn thuộc đúng Ngành đang chọn ở filter — không lọc
  // cứng, vì về nguyên tắc 1 môn của ngành khác vẫn có thể hợp lệ trong khung chương trình.
  const selectableSubjects = useMemo(() => {
    const filtered = subjects.filter((s) => s.IsActive || String(s.SubjectId) === form.subjectId);
    const currentMajorId = majorId ? Number(majorId) : null;
    if (!currentMajorId) return filtered;
    return [...filtered].sort((a, b) => {
      const aMatch = a.MajorId === currentMajorId ? 0 : 1;
      const bMatch = b.MajorId === currentMajorId ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [subjects, form.subjectId, majorId]);

  async function loadLookups() {
    const [majorRes, subjectRes, cohortRes] = await Promise.all([
      axiosClient.get<Major[]>("/majors"),
      axiosClient.get<Subject[]>("/subjects"),
      axiosClient.get<Cohort[]>("/cohorts"),
    ]);
    setMajors(majorRes.data);
    setSubjects(subjectRes.data);
    setCohorts(cohortRes.data);
    if (majorRes.data.length > 0) setMajorId(String(majorRes.data[0].MajorId));
  }
  useEffect(() => { loadLookups(); }, []);

  const filteredMajors = useMemo(
    () => (trainingModeFilter ? majors.filter((m) => m.TrainingMode === trainingModeFilter) : majors),
    [majors, trainingModeFilter]
  );

  function handleTrainingModeFilterChange(value: string) {
    setTrainingModeFilter(value);
    const nextMajors = value ? majors.filter((m) => m.TrainingMode === value) : majors;
    setMajorId(nextMajors.length > 0 ? String(nextMajors[0].MajorId) : "");
    resetForm();
  }

  async function loadItems() {
    if (!majorId) {
      setItems([]);
      return;
    }
    const params: Record<string, string> = { majorId };
    if (cohortFilter) params.cohortId = cohortFilter;
    const res = await axiosClient.get<CurriculumItem[]>("/curriculum-items", { params });
    setItems(res.data);
  }
  useEffect(() => { loadItems(); }, [majorId, cohortFilter]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editingId) {
        await axiosClient.put(`/curriculum-items/${editingId}`, {
          termNumber: Number(form.termNumber),
          credits: form.credits ? Number(form.credits) : undefined,
          totalHours: form.totalHours ? Number(form.totalHours) : undefined,
          theoryHours: form.theoryHours ? Number(form.theoryHours) : undefined,
          practiceHours: form.practiceHours ? Number(form.practiceHours) : undefined,
          examHours: form.examHours ? Number(form.examHours) : undefined,
          cohortId: form.cohortId ? Number(form.cohortId) : undefined,
          sortOrder: form.sortOrder ? Number(form.sortOrder) : 0,
          practiceMode: form.practiceMode,
          isActive: true,
        });
      } else {
        await axiosClient.post("/curriculum-items", {
          majorId: Number(majorId),
          subjectId: Number(form.subjectId),
          termNumber: Number(form.termNumber),
          credits: form.credits ? Number(form.credits) : undefined,
          totalHours: form.totalHours ? Number(form.totalHours) : undefined,
          theoryHours: form.theoryHours ? Number(form.theoryHours) : undefined,
          practiceHours: form.practiceHours ? Number(form.practiceHours) : undefined,
          examHours: form.examHours ? Number(form.examHours) : undefined,
          cohortId: form.cohortId ? Number(form.cohortId) : undefined,
          sortOrder: form.sortOrder ? Number(form.sortOrder) : undefined,
          practiceMode: form.practiceMode,
        });
      }
      resetForm();
      loadItems();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: CurriculumItem) {
    setEditingId(item.CurriculumItemId);
    setForm({
      subjectId: String(item.SubjectId),
      termNumber: String(item.TermNumber),
      credits: item.Credits != null ? String(item.Credits) : "",
      totalHours: item.TotalHours != null ? String(item.TotalHours) : "",
      theoryHours: item.TheoryHours != null ? String(item.TheoryHours) : "",
      practiceHours: item.PracticeHours != null ? String(item.PracticeHours) : "",
      examHours: item.ExamHours != null ? String(item.ExamHours) : "",
      cohortId: item.CohortId != null ? String(item.CohortId) : "",
      sortOrder: String(item.SortOrder),
      practiceMode: item.PracticeMode || "ThucHanh",
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Bỏ môn học này khỏi khung chương trình?")) return;
    await axiosClient.delete(`/curriculum-items/${id}`);
    loadItems();
  }

  function downloadSampleTemplate() {
    const sheetMajors = majors.length > 0 ? majors : [{ MajorId: 0, MajorName: "Tên ngành (phải khớp ngành đã có)", IsActive: true }];
    const wb = buildWorkbook(sheetMajors.map((m) => ({
      name: m.MajorName,
      rows: [{
        "Mã MĐ": "Y09",
        "Tên mô-đun": "Dược lý học",
        "Số tín chỉ": 3,
        "Tổng số giờ": 45,
        "Giờ lý thuyết": 30,
        "Giờ thực hành": 15,
        "Giờ thi/kiểm tra": 2,
        "Kỳ": "II",
        "Hình thức TH": "Thực hành",
      }],
    })));
    downloadWorkbook(wb, "Mau_Import_KhungChuongTrinh.xlsx");
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportResult(null);
    setImportResultDetails([]);
    const wb = await readWorkbook(file);
    const rows = wb.SheetNames.flatMap((name) =>
      parseSheetRows(name, sheetToRows<ExcelCurriculumRow>(wb.Sheets[name]), majors, subjects)
    );
    setImportRows(rows);
  }

  function toggleRow(key: string) {
    setImportRows((rows) => rows.map((r) => (r.key === key ? { ...r, selected: !r.selected } : r)));
  }

  function setRowResolution(key: string, resolution: "use-existing" | "create-new") {
    setImportRows((rows) => rows.map((r) => (r.key === key ? { ...r, resolution } : r)));
  }

  function setRowNewName(key: string, newName: string) {
    setImportRows((rows) => rows.map((r) => (r.key === key ? { ...r, newName } : r)));
  }

  function closeImport() {
    setShowImport(false);
    setImportRows([]);
    setImportResult(null);
    setImportResultDetails([]);
  }

  async function handleConfirmImport() {
    const toSend = importRows.filter((r) => r.selected && !r.error);
    if (toSend.length === 0) return;
    if (toSend.some((r) => isUnresolvedDuplicate(r, subjects))) {
      setError("Có dòng chọn \"Đây là môn khác, tạo mới\" nhưng tên vẫn trùng hoặc để trống — sửa lại trước khi nhập.");
      return;
    }
    setError("");
    setImporting(true);
    try {
      const res = await axiosClient.post<BulkImportResult>("/curriculum-items/bulk", {
        items: toSend.map((r) => ({
          majorId: r.majorId,
          cohortId: importCohortId ? Number(importCohortId) : undefined,
          subjectCode: r.subjectCode,
          subjectName: r.duplicateOf && r.resolution === "create-new" ? r.newName.trim() : r.subjectName,
          credits: r.credits ?? undefined,
          totalHours: r.totalHours,
          theoryHours: r.theoryHours,
          practiceHours: r.practiceHours,
          examHours: r.examHours,
          termNumber: r.termNumber,
          practiceMode: r.practiceMode,
        })),
      });
      setImportResult(res.data);
      setImportResultDetails(res.data.errors.map((e) => {
        const row = toSend[e.index];
        return `${row.sheetName} - dòng ${row.rowNum} (${row.subjectCode}): ${e.message}`;
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

  const importRowsBySheet = useMemo(() => {
    const map: Record<string, ImportRow[]> = {};
    for (const r of importRows) {
      if (!map[r.sheetName]) map[r.sheetName] = [];
      map[r.sheetName].push(r);
    }
    return map;
  }, [importRows]);

  const validCount = importRows.filter((r) => !r.error).length;
  const selectedCount = importRows.filter((r) => r.selected && !r.error).length;

  const itemsByTerm = useMemo(() => {
    const map: Record<number, CurriculumItem[]> = {};
    for (const it of items) {
      if (!map[it.TermNumber]) map[it.TermNumber] = [];
      map[it.TermNumber].push(it);
    }
    return map;
  }, [items]);

  return (
    <div>
      <h1>Khung chương trình đào tạo</h1>
      <p className="hint">Gán môn học vào từng ngành theo từng kỳ học. Một môn có thể dùng chung cho nhiều ngành.</p>

      <div className="filter-bar">
        <select value={trainingModeFilter} onChange={(e) => handleTrainingModeFilterChange(e.target.value)}>
          <option value="">-- Tất cả hệ đào tạo --</option>
          <option value="CQ">Chính quy (CQ)</option>
          <option value="LT">Liên thông (LT)</option>
        </select>
        <select value={cohortFilter} onChange={(e) => setCohortFilter(e.target.value)}>
          <option value="">-- Tất cả các khóa --</option>
          {cohorts.map((c) => <option key={c.CohortId} value={c.CohortId}>{c.CohortName}</option>)}
        </select>
        <select value={majorId} onChange={(e) => { setMajorId(e.target.value); resetForm(); }}>
          {filteredMajors.length === 0 && <option value="">-- Không có ngành nào --</option>}
          {filteredMajors.map((m) => <option key={m.MajorId} value={m.MajorId}>{m.MajorName}</option>)}
        </select>
        <button type="button" onClick={() => setShowImport((v) => !v)}>
          {showImport ? "Đóng nhập Excel" : "Nhập từ Excel"}
        </button>
        <button type="button" onClick={downloadSampleTemplate}>Tải file mẫu</button>
      </div>

      {showImport && (
        <div className="inline-form items-start flex-col">
          <p className="hint">
            Mỗi sheet trong file Excel là 1 ngành (tên sheet phải khớp đúng tên ngành đã có trong hệ thống).
            Môn học được khớp theo TÊN môn đã chuẩn hóa (không phân biệt hoa/thường, khoảng trắng thừa quanh
            dấu gạch ngang) — dòng nào trùng với môn đã có sẽ hỏi rõ trước khi nhập, không tự động gộp hay
            tạo mới; dòng tên hoàn toàn mới thì xử lý bình thường.
          </p>
          <label className="flex items-center gap-2">
            <span className="hint mt-0">Khóa học áp dụng (tùy chọn):</span>
            <select value={importCohortId} onChange={(e) => setImportCohortId(e.target.value)}>
              <option value="">-- Áp dụng chung cho mọi khóa --</option>
              {cohorts.map((c) => <option key={c.CohortId} value={c.CohortId}>{c.CohortName}</option>)}
            </select>
          </label>
          <input type="file" accept=".xlsx,.xls" onChange={handleFile} />

          {importRows.length > 0 && (
            <>
              <p className="hint mt-2">
                {validCount}/{importRows.length} dòng hợp lệ — {selectedCount} dòng sẽ được nhập.
              </p>
              {Object.entries(importRowsBySheet).map(([sheetName, rows]) => (
                <div key={sheetName} className="mb-3 w-full">
                  <h3 className="text-brand text-sm font-semibold mb-2">{sheetName}</h3>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th></th><th>Dòng</th><th>Mã MĐ</th><th>Tên mô-đun</th><th>Tín chỉ</th>
                        <th>Tổng giờ</th><th>LT</th><th>TH</th><th>Thi</th><th>Kỳ</th><th>Hình thức TH</th>
                        <th>Trùng tên?</th><th>Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key}>
                          <td>
                            <input type="checkbox" checked={r.selected} disabled={!!r.error}
                              onChange={() => toggleRow(r.key)} />
                          </td>
                          <td>{r.rowNum}</td>
                          <td>{r.subjectCode}</td>
                          <td>{r.subjectName}</td>
                          <td>{r.credits}</td>
                          <td>{r.totalHours}</td>
                          <td>{r.theoryHours}</td>
                          <td>{r.practiceHours}</td>
                          <td>{r.examHours}</td>
                          <td>{r.termRaw}</td>
                          <td>{PRACTICE_MODE_LABEL[r.practiceMode] || r.practiceMode}</td>
                          <td>
                            {r.duplicateOf ? (
                              <div className="text-[13px]">
                                <div className="hint mt-0">
                                  Đã có: <b>{r.duplicateOf.SubjectName}</b> ({r.duplicateOf.FacultyName || "chưa gán khoa"})
                                </div>
                                <label className="flex items-center gap-1">
                                  <input type="radio" name={`dup-${r.key}`} checked={r.resolution === "use-existing"}
                                    onChange={() => setRowResolution(r.key, "use-existing")} />
                                  Dùng chung
                                </label>
                                <label className="flex items-center gap-1">
                                  <input type="radio" name={`dup-${r.key}`} checked={r.resolution === "create-new"}
                                    onChange={() => setRowResolution(r.key, "create-new")} />
                                  Đây là môn khác, tạo mới
                                </label>
                                {r.resolution === "create-new" && (
                                  <>
                                    <input value={r.newName} onChange={(e) => setRowNewName(r.key, e.target.value)}
                                      placeholder="Tên môn mới" className="mt-1 w-full" />
                                    {isUnresolvedDuplicate(r, subjects) && (
                                      <div className="error-text mt-0">Tên này vẫn trùng — đổi tên khác</div>
                                    )}
                                  </>
                                )}
                              </div>
                            ) : "—"}
                          </td>
                          <td>
                            {r.error
                              ? <span className="error-text mt-0">{r.error}</span>
                              : <span className="text-green-600 text-[13px]">✓ Hợp lệ</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  disabled={selectedCount === 0 || importing || importRows.some((r) => r.selected && isUnresolvedDuplicate(r, subjects))}
                  onClick={handleConfirmImport}
                >
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

      {majorId && (
        <form className="inline-form" onSubmit={handleSubmit}>
          <select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}
            required disabled={!!editingId}>
            <option value="">-- Chọn môn học --</option>
            {selectableSubjects.map((s) => (
              <option key={s.SubjectId} value={s.SubjectId}>
                {subjectLabel(s)}{!s.IsActive ? " (Ngừng dùng)" : ""}
              </option>
            ))}
          </select>
          <input type="number" placeholder="Kỳ thứ mấy" min={1} value={form.termNumber}
            onChange={(e) => setForm({ ...form, termNumber: e.target.value })} required />
          <input type="number" placeholder="Tín chỉ (ghi đè, để trống = mặc định)" value={form.credits}
            onChange={(e) => setForm({ ...form, credits: e.target.value })} />
          <input type="number" placeholder="Tổng số giờ (ghi đè, để trống = mặc định)" value={form.totalHours}
            onChange={(e) => setForm({ ...form, totalHours: e.target.value })} />
          <input type="number" placeholder="Giờ lý thuyết (ghi đè, để trống = mặc định)" value={form.theoryHours}
            onChange={(e) => setForm({ ...form, theoryHours: e.target.value })} />
          <input type="number" placeholder="Giờ thực hành (ghi đè, để trống = mặc định)" value={form.practiceHours}
            onChange={(e) => setForm({ ...form, practiceHours: e.target.value })} />
          <input type="number" placeholder="Giờ thi/kiểm tra (ghi đè, để trống = mặc định)" value={form.examHours}
            onChange={(e) => setForm({ ...form, examHours: e.target.value })} />
          <select value={form.practiceMode} onChange={(e) => setForm({ ...form, practiceMode: e.target.value })}>
            {PRACTICE_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={form.cohortId} onChange={(e) => setForm({ ...form, cohortId: e.target.value })}>
            <option value="">-- Tất cả các khóa --</option>
            {cohorts.map((c) => <option key={c.CohortId} value={c.CohortId}>{c.CohortName}</option>)}
          </select>
          <input type="number" placeholder="Thứ tự hiển thị" value={form.sortOrder}
            onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
          <button type="submit">{editingId ? "Cập nhật" : "Thêm vào chương trình"}</button>
          {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
        </form>
      )}
      {error && <div className="error-text">{error}</div>}

      {Object.keys(itemsByTerm).length === 0 && majorId && (
        <p className="hint">Ngành này chưa có môn học nào trong khung chương trình.</p>
      )}

      {Object.entries(itemsByTerm)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([term, rows]) => {
          const totals = rows.reduce(
            (acc, it) => ({
              credits: acc.credits + (it.Credits ?? 0),
              totalHours: acc.totalHours + (it.TotalHours ?? 0),
              theoryHours: acc.theoryHours + (it.TheoryHours ?? 0),
              practiceHours: acc.practiceHours + (it.PracticeHours ?? 0),
              examHours: acc.examHours + (it.ExamHours ?? 0),
            }),
            { credits: 0, totalHours: 0, theoryHours: 0, practiceHours: 0, examHours: 0 }
          );
          return (
            <div key={term} className="mb-5">
              <h3 className="text-brand text-sm font-semibold mb-2">Kỳ {term}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Môn học</th><th>Mã môn</th><th>Khóa</th><th>Tín chỉ</th>
                    <th>Tổng giờ</th><th>LT</th><th>TH</th><th>Thi</th><th>Hình thức TH</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((it, idx) => (
                    <tr key={it.CurriculumItemId}>
                      <td>{idx + 1}</td>
                      <td>{it.SubjectName}</td>
                      <td>{it.SubjectCode}</td>
                      <td>{it.CohortName || "Tất cả"}</td>
                      <td>{it.Credits}</td>
                      <td>{it.TotalHours}</td>
                      <td>{it.TheoryHours}</td>
                      <td>{it.PracticeHours}</td>
                      <td>{it.ExamHours}</td>
                      <td>{PRACTICE_MODE_LABEL[it.PracticeMode] || it.PracticeMode}</td>
                      <td>
                        <button onClick={() => handleEdit(it)}>Sửa</button>
                        <button onClick={() => handleDelete(it.CurriculumItemId)}>Xóa</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold bg-gray-50">
                    <td></td>
                    <td>Tổng cộng</td>
                    <td></td>
                    <td></td>
                    <td>{totals.credits}</td>
                    <td>{totals.totalHours}</td>
                    <td>{totals.theoryHours}</td>
                    <td>{totals.practiceHours}</td>
                    <td>{totals.examHours}</td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        })}
    </div>
  );
}
