import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Subject, Faculty, BulkImportResult, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";
import { readWorkbook, sheetToRows, buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { normalizeText } from "../../../utils/text";

interface SubjectForm {
  subjectCode: string;
  subjectName: string;
  facultyId: string;
  credits: string;
  theoryHours: string;
  practiceHours: string;
  examHours: string;
}

const emptyForm: SubjectForm = {
  subjectCode: "", subjectName: "", facultyId: "", credits: "", theoryHours: "", practiceHours: "", examHours: "",
};

interface ExcelSubjectRow {
  "Mã môn"?: string | number;
  "Tên môn"?: string;
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
  duplicateOf: Subject | null;
  resolution: "use-existing" | "create-new";
  newName: string;
}

function parseImportRow(raw: ExcelSubjectRow, rowNum: number, faculties: Faculty[], existingSubjects: Subject[]): ImportRow {
  const subjectCode = String(raw["Mã môn"] ?? "").trim();
  const subjectName = String(raw["Tên môn"] ?? "").trim();
  const facultyRaw = String(raw["Khoa"] ?? "").trim();
  const creditsRaw = raw["Số tín chỉ"];
  const credits = creditsRaw !== undefined && creditsRaw !== "" ? Number(creditsRaw) : null;
  const theoryHours = Number(raw["Giờ lý thuyết"]) || 0;
  const practiceHours = Number(raw["Giờ thực hành"]) || 0;
  const examHours = Number(raw["Giờ thi/kiểm tra"]) || 0;
  const category = String(raw["Phân loại"] ?? "").trim();

  let error: string | null = null;
  let errorDetail: string | undefined;
  let facultyId: number | null = null;
  if (!subjectName) error = "Thiếu tên môn học";
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

  const duplicateOf = subjectName
    ? existingSubjects.find((s) => normalizeText(s.SubjectName) === normalizeText(subjectName)) || null
    : null;
  const newName = duplicateOf
    ? (facultyRaw ? `${subjectName} (${facultyRaw})` : `${subjectName} (mới)`)
    : subjectName;

  return {
    rowNum, subjectCode, subjectName, facultyRaw, facultyId,
    credits, theoryHours, practiceHours, examHours, category,
    error, errorDetail, selected: !error,
    duplicateOf, resolution: "use-existing", newName,
  };
}

// Dòng chọn "Đây là môn khác, tạo mới" mà tên vẫn trùng (hoặc bỏ trống) — chưa thể nhập được.
function isUnresolvedDuplicate(row: ImportRow, existingSubjects: Subject[]): boolean {
  if (row.resolution !== "create-new") return false;
  const trimmed = row.newName.trim();
  if (!trimmed) return true;
  return existingSubjects.some((s) => normalizeText(s.SubjectName) === normalizeText(trimmed));
}

export default function Subjects() {
  const [items, setItems] = useState<Subject[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [form, setForm] = useState<SubjectForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [importResultDetails, setImportResultDetails] = useState<string[]>([]);
  const [importSkippedDetails, setImportSkippedDetails] = useState<string[]>([]);

  async function load() {
    const [subRes, facultyRes] = await Promise.all([
      axiosClient.get<Subject[]>("/subjects"),
      axiosClient.get<Faculty[]>("/faculties"),
    ]);
    setItems(subRes.data);
    setFaculties(facultyRes.data);
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
      subjectCode: form.subjectCode,
      subjectName: form.subjectName,
      facultyId: form.facultyId ? Number(form.facultyId) : undefined,
      credits: form.credits ? Number(form.credits) : undefined,
      theoryHours: Number(form.theoryHours) || 0,
      practiceHours: Number(form.practiceHours) || 0,
      examHours: Number(form.examHours) || 0,
    };
    try {
      if (editingId) {
        await axiosClient.put(`/subjects/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/subjects", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  function handleEdit(item: Subject) {
    setEditingId(item.SubjectId);
    setForm({
      subjectCode: item.SubjectCode || "",
      subjectName: item.SubjectName,
      facultyId: item.FacultyId ? String(item.FacultyId) : "",
      credits: item.Credits != null ? String(item.Credits) : "",
      theoryHours: String(item.TheoryHours),
      practiceHours: String(item.PracticeHours),
      examHours: String(item.ExamHours),
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa môn học này?")) return;
    try {
      await axiosClient.delete(`/subjects/${id}`);
      load();
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
          "Mã môn": "Y09",
          "Tên môn": "Dược lý học",
          "Khoa": faculties[0]?.FacultyName || "Khoa Dược",
          "Số tín chỉ": 3,
          "Giờ lý thuyết": 30,
          "Giờ thực hành": 15,
          "Giờ thi/kiểm tra": 2,
          "Phân loại": "Chuyên ngành",
        },
        {
          "Mã môn": "D01",
          "Tên môn": "Giáo dục thể chất",
          "Khoa": "",
          "Số tín chỉ": 1,
          "Giờ lý thuyết": 15,
          "Giờ thực hành": 0,
          "Giờ thi/kiểm tra": 0,
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
    setImportSkippedDetails([]);
    const wb = await readWorkbook(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raws = sheetToRows<ExcelSubjectRow>(sheet);
    setImportRows(raws.map((r, idx) => parseImportRow(r, idx + 2, faculties, items)));
  }

  function toggleRow(rowNum: number) {
    setImportRows((rows) => rows.map((r) => (r.rowNum === rowNum ? { ...r, selected: !r.selected } : r)));
  }

  function setRowResolution(rowNum: number, resolution: "use-existing" | "create-new") {
    setImportRows((rows) => rows.map((r) => (r.rowNum === rowNum ? { ...r, resolution } : r)));
  }

  function setRowNewName(rowNum: number, newName: string) {
    setImportRows((rows) => rows.map((r) => (r.rowNum === rowNum ? { ...r, newName } : r)));
  }

  function closeImport() {
    setShowImport(false);
    setImportRows([]);
    setImportResult(null);
    setImportResultDetails([]);
    setImportSkippedDetails([]);
  }

  async function handleConfirmImport() {
    const selected = importRows.filter((r) => r.selected && !r.error);
    if (selected.length === 0) return;
    if (selected.some((r) => isUnresolvedDuplicate(r, items))) {
      setError("Có dòng chọn \"Đây là môn khác, tạo mới\" nhưng tên vẫn trùng hoặc để trống — sửa lại trước khi nhập.");
      return;
    }
    setError("");
    setImporting(true);
    try {
      const res = await axiosClient.post<BulkImportResult>("/subjects/bulk", {
        subjects: selected.map((r) => ({
          subjectCode: r.subjectCode || undefined,
          subjectName: r.duplicateOf && r.resolution === "create-new" ? r.newName.trim() : r.subjectName,
          facultyId: r.facultyId ?? undefined,
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
        return `Dòng ${row.rowNum} (${row.subjectName}): ${e.message}`;
      }));
      setImportSkippedDetails((res.data.skipped || []).map((s) => {
        const row = selected[s.index];
        return `Dòng ${row.rowNum} (${row.subjectName}): ${s.message}`;
      }));
      setImportRows([]);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi khi nhập dữ liệu");
    } finally {
      setImporting(false);
    }
  }

  const validCount = importRows.filter((r) => !r.error).length;
  const selectedCount = importRows.filter((r) => r.selected && !r.error).length;

  return (
    <div>
      <h1>Quản lý Môn học</h1>
      <p className="hint">
        Môn học không gắn cứng với 1 ngành — để phân bổ môn theo từng ngành và kỳ học, vào mục
        "Khung chương trình đào tạo".
      </p>

      <div className="filter-bar">
        <button type="button" onClick={() => setShowImport((v) => !v)}>
          {showImport ? "Đóng nhập Excel" : "Nhập từ Excel"}
        </button>
        <button type="button" onClick={downloadSampleTemplate}>Tải file mẫu</button>
      </div>

      {showImport && (
        <div className="inline-form items-start flex-col">
          <p className="hint">
            Môn học được kiểm tra trùng theo TÊN đã chuẩn hóa (không phân biệt hoa/thường, khoảng trắng
            thừa quanh dấu gạch ngang) — dòng nào trùng với môn đã có sẽ hỏi rõ trước khi nhập, không tự
            động gộp hay bỏ qua.
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
                    <th></th><th>Dòng</th><th>Mã môn</th><th>Tên môn</th><th>Khoa</th>
                    <th>Tín chỉ</th><th>LT</th><th>TH</th><th>Thi</th><th>Phân loại</th>
                    <th>Trùng tên?</th><th>Trạng thái</th>
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
                      <td>{r.facultyRaw}</td>
                      <td>{r.credits}</td>
                      <td>{r.theoryHours}</td>
                      <td>{r.practiceHours}</td>
                      <td>{r.examHours}</td>
                      <td>{r.category}</td>
                      <td>
                        {r.duplicateOf ? (
                          <div className="text-[13px]">
                            <div className="hint mt-0">
                              Đã có: <b>{r.duplicateOf.SubjectName}</b> ({r.duplicateOf.FacultyName || "chưa gán khoa"})
                            </div>
                            <label className="flex items-center gap-1">
                              <input type="radio" name={`dup-${r.rowNum}`} checked={r.resolution === "use-existing"}
                                onChange={() => setRowResolution(r.rowNum, "use-existing")} />
                              Dùng chung
                            </label>
                            <label className="flex items-center gap-1">
                              <input type="radio" name={`dup-${r.rowNum}`} checked={r.resolution === "create-new"}
                                onChange={() => setRowResolution(r.rowNum, "create-new")} />
                              Đây là môn khác, tạo mới
                            </label>
                            {r.resolution === "create-new" && (
                              <>
                                <input value={r.newName} onChange={(e) => setRowNewName(r.rowNum, e.target.value)}
                                  placeholder="Tên môn mới" className="mt-1 w-full" />
                                {isUnresolvedDuplicate(r, items) && (
                                  <div className="error-text mt-0">Tên này vẫn trùng — đổi tên khác</div>
                                )}
                              </>
                            )}
                          </div>
                        ) : "—"}
                      </td>
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
                <button
                  type="button"
                  disabled={selectedCount === 0 || importing || importRows.some((r) => r.selected && isUnresolvedDuplicate(r, items))}
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
                Đã nhập thành công {importResult.successCount} dòng
                {(importResult.skippedCount ?? 0) > 0 && `, bỏ qua ${importResult.skippedCount} dòng đã tồn tại`}
                , lỗi {importResult.errorCount} dòng.
              </p>
              {importSkippedDetails.length > 0 && (
                <ul className="text-[13px] text-gray-500 list-disc pl-5">
                  {importSkippedDetails.map((msg, i) => <li key={i}>{msg}</li>)}
                </ul>
              )}
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
          onChange={(e) => setForm({ ...form, subjectCode: e.target.value })} />
        <input placeholder="Tên môn học" value={form.subjectName}
          onChange={(e) => setForm({ ...form, subjectName: e.target.value })} required />
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
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th><th>Mã môn</th><th>Tên môn</th><th>Khoa</th><th>Tín chỉ</th>
            <th>LT</th><th>TH</th><th>Thi</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.SubjectId}>
              <td>{idx + 1}</td>
              <td>{it.SubjectCode}</td>
              <td>{it.SubjectName}</td>
              <td>{it.FacultyName}</td>
              <td>{it.Credits}</td>
              <td>{it.TheoryHours}</td>
              <td>{it.PracticeHours}</td>
              <td>{it.ExamHours}</td>
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
