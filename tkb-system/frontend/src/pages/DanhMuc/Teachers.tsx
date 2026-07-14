import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import axiosClient from "../../api/axiosClient";
import { Teacher, TeacherDetail, Faculty, Position, Subject, TeacherUnavailability, BulkImportResult, ApiErrorResponse } from "../../types";
import { AxiosError } from "axios";
import { readWorkbook, sheetToRows, buildWorkbook, downloadWorkbook } from "../../../utils/excel";
import { normalizeText, subjectLabel } from "../../../utils/text";

interface TeacherForm {
  fullName: string;
  facultyId: string;
  positionId: string;
  phone: string;
  email: string;
  subjectIds: string[];
}

const emptyForm: TeacherForm = { fullName: "", facultyId: "", positionId: "", phone: "", email: "", subjectIds: [] };

interface ImportRow {
  rowNum: number;
  fullName: string;
  facultyRaw: string;
  facultyId: number | null;
  positionRaw: string;
  positionId: number | null;
  phone: string;
  email: string;
  error: string | null;
  selected: boolean;
}

interface ExcelTeacherRow {
  "Họ và tên"?: string;
  "Khoa"?: string;
  "Chức vụ"?: string;
  "Số điện thoại"?: string;
  "Email"?: string;
}

function parseImportRow(raw: ExcelTeacherRow, rowNum: number, faculties: Faculty[], positions: Position[]): ImportRow {
  const fullName = String(raw["Họ và tên"] ?? "").trim();
  const facultyRaw = String(raw["Khoa"] ?? "").trim();
  const positionRaw = String(raw["Chức vụ"] ?? "").trim();
  const phone = String(raw["Số điện thoại"] ?? "").trim();
  const email = String(raw["Email"] ?? "").trim();

  let error: string | null = null;
  let facultyId: number | null = null;
  let positionId: number | null = null;
  if (!fullName) error = "Thiếu họ và tên";
  if (facultyRaw) {
    const match = faculties.find((f) => f.FacultyName.trim().toLowerCase() === facultyRaw.toLowerCase());
    if (match) facultyId = match.FacultyId;
    else if (!error) error = `Không tìm thấy khoa "${facultyRaw}"`;
  }
  if (positionRaw) {
    const match = positions.find((p) => p.PositionName.trim().toLowerCase() === positionRaw.toLowerCase());
    if (match) positionId = match.PositionId;
    else if (!error) error = `Không tìm thấy chức vụ "${positionRaw}"`;
  }

  return { rowNum, fullName, facultyRaw, facultyId, positionRaw, positionId, phone, email, error, selected: !error };
}

// Việc BC: checkbox "cha" của 1 nhóm môn cùng tên (nhiều mã khác nhau theo Ngành) — tick/bỏ tick 1
// lần áp dụng cho TẤT CẢ mã con trong nhóm. `indeterminate` không phải prop JSX chuẩn nên phải set
// trực tiếp qua ref khi chỉ MỘT PHẦN mã con đang được chọn.
function SubjectGroupCheckbox({
  ids, subjectIds, onToggle,
}: { ids: number[]; subjectIds: string[]; onToggle: (checkAll: boolean) => void }) {
  const idStrs = useMemo(() => ids.map(String), [ids]);
  const checkedCount = idStrs.filter((id) => subjectIds.includes(id)).length;
  const allChecked = checkedCount === idStrs.length;
  const someChecked = checkedCount > 0 && !allChecked;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someChecked;
  }, [someChecked]);
  return <input type="checkbox" ref={ref} checked={allChecked} onChange={(e) => onToggle(e.target.checked)} />;
}

export default function Teachers() {
  const [items, setItems] = useState<Teacher[]>([]);
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [form, setForm] = useState<TeacherForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);

  const [unavailItems, setUnavailItems] = useState<TeacherUnavailability[]>([]);
  const [unavailForm, setUnavailForm] = useState({ teacherId: "", dateFrom: "", dateTo: "", reason: "" });
  const [unavailError, setUnavailError] = useState("");

  // Môn "Ngừng sử dụng" bị ẩn khỏi lựa chọn CHỌN THÊM mới, nhưng môn đã được gán sẵn cho GV đang
  // sửa (kể cả khi đã ngừng dùng) vẫn phải hiện trong danh sách, không được làm mất lựa chọn cũ.
  const selectableSubjects = useMemo(
    () => subjects.filter((s) => s.IsActive || form.subjectIds.includes(String(s.SubjectId))),
    [subjects, form.subjectIds]
  );

  // Việc BC: Môn học nay tách riêng theo Ngành (mỗi ngành 1 mã, có thể trùng tên) — 1 GV dạy chung 1
  // môn cho nhiều ngành phải tick từng mã. Nhóm theo TÊN MÔN đã chuẩn hóa để hiện 1 checkbox "cha"
  // cho các môn có từ 2 mã trùng tên trở lên, cho phép tick nhanh cả nhóm.
  const [subjectSearch, setSubjectSearch] = useState("");
  const subjectGroups = useMemo(() => {
    const map = new Map<string, { displayName: string; items: Subject[] }>();
    for (const s of selectableSubjects) {
      const key = normalizeText(s.SubjectName);
      if (!map.has(key)) map.set(key, { displayName: s.SubjectName, items: [] });
      map.get(key)!.items.push(s);
    }
    return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [selectableSubjects]);

  const filteredSubjectGroups = useMemo(() => {
    const q = normalizeText(subjectSearch);
    if (!q) return subjectGroups;
    return subjectGroups.filter((g) => normalizeText(g.displayName).includes(q));
  }, [subjectGroups, subjectSearch]);

  function toggleSubject(id: number) {
    const idStr = String(id);
    setForm((f) => ({
      ...f,
      subjectIds: f.subjectIds.includes(idStr) ? f.subjectIds.filter((x) => x !== idStr) : [...f.subjectIds, idStr],
    }));
  }

  function toggleSubjectGroup(ids: number[], checkAll: boolean) {
    const idStrs = ids.map(String);
    setForm((f) => ({
      ...f,
      subjectIds: checkAll
        ? Array.from(new Set([...f.subjectIds, ...idStrs]))
        : f.subjectIds.filter((x) => !idStrs.includes(x)),
    }));
  }

  async function load() {
    const [teacherRes, facultyRes, positionRes, subjectRes, unavailRes] = await Promise.all([
      axiosClient.get<Teacher[]>("/teachers"),
      axiosClient.get<Faculty[]>("/faculties"),
      axiosClient.get<Position[]>("/positions"),
      axiosClient.get<Subject[]>("/subjects"),
      axiosClient.get<TeacherUnavailability[]>("/teacher-unavailability"),
    ]);
    setItems(teacherRes.data);
    setFaculties(facultyRes.data);
    setPositions(positionRes.data);
    setSubjects(subjectRes.data);
    setUnavailItems(unavailRes.data);
  }
  useEffect(() => { load(); }, []);

  async function handleUnavailSubmit(e: FormEvent) {
    e.preventDefault();
    setUnavailError("");
    if (unavailForm.dateTo < unavailForm.dateFrom) {
      setUnavailError("Ngày kết thúc phải sau ngày bắt đầu");
      return;
    }
    try {
      await axiosClient.post("/teacher-unavailability", {
        teacherId: Number(unavailForm.teacherId),
        dateFrom: unavailForm.dateFrom,
        dateTo: unavailForm.dateTo,
        reason: unavailForm.reason || undefined,
      });
      setUnavailForm({ teacherId: "", dateFrom: "", dateTo: "", reason: "" });
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setUnavailError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  async function handleUnavailDelete(id: number) {
    if (!confirm("Xóa khai báo báo bận này?")) return;
    await axiosClient.delete(`/teacher-unavailability/${id}`);
    load();
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const payload = {
      fullName: form.fullName,
      facultyId: form.facultyId ? Number(form.facultyId) : undefined,
      positionId: form.positionId ? Number(form.positionId) : undefined,
      phone: form.phone,
      email: form.email,
      subjectIds: form.subjectIds.map(Number),
    };
    try {
      if (editingId) {
        await axiosClient.put(`/teachers/${editingId}`, { ...payload, isActive: true });
      } else {
        await axiosClient.post("/teachers", payload);
      }
      resetForm();
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      setError(axiosErr.response?.data?.message || "Có lỗi xảy ra");
    }
  }

  async function handleEdit(item: Teacher) {
    const res = await axiosClient.get<TeacherDetail>(`/teachers/${item.TeacherId}`);
    const detail = res.data;
    setEditingId(item.TeacherId);
    setForm({
      fullName: detail.FullName,
      facultyId: detail.FacultyId ? String(detail.FacultyId) : "",
      positionId: detail.PositionId ? String(detail.PositionId) : "",
      phone: detail.Phone || "",
      email: detail.Email || "",
      subjectIds: detail.subjects.map((s) => String(s.SubjectId)),
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Xóa giảng viên này?")) return;
    try {
      await axiosClient.delete(`/teachers/${id}`);
      load();
    } catch (err) {
      const axiosErr = err as AxiosError<ApiErrorResponse>;
      alert(axiosErr.response?.data?.message || "Không thể xóa");
    }
  }

  function downloadSampleTemplate() {
    const wb = buildWorkbook([{
      name: "Giảng viên",
      rows: [{
        "Họ và tên": "Nguyễn Văn A",
        "Khoa": faculties[0]?.FacultyName || "Khoa Dược",
        "Chức vụ": positions[0]?.PositionName || "Giảng viên",
        "Số điện thoại": "0901234567",
        "Email": "nguyenvana@example.com",
      }],
    }]);
    downloadWorkbook(wb, "Mau_Import_GiangVien.xlsx");
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportResult(null);
    const wb = await readWorkbook(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raws = sheetToRows<ExcelTeacherRow>(sheet);
    setImportRows(raws.map((r, idx) => parseImportRow(r, idx + 2, faculties, positions)));
  }

  function toggleRow(rowNum: number) {
    setImportRows((rows) => rows.map((r) => (r.rowNum === rowNum ? { ...r, selected: !r.selected } : r)));
  }

  function closeImport() {
    setShowImport(false);
    setImportRows([]);
    setImportResult(null);
  }

  async function handleConfirmImport() {
    const selected = importRows.filter((r) => r.selected && !r.error);
    if (selected.length === 0) return;
    setImporting(true);
    try {
      const res = await axiosClient.post<BulkImportResult>("/teachers/bulk", {
        teachers: selected.map((r) => ({
          fullName: r.fullName,
          facultyId: r.facultyId ?? undefined,
          positionId: r.positionId ?? undefined,
          phone: r.phone || undefined,
          email: r.email || undefined,
        })),
      });
      setImportResult(res.data);
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
      <h1>Quản lý Giảng viên</h1>
      <p className="hint">
        Có thể nhập nhanh danh sách giảng viên từ file Excel (cột: Họ và tên, Khoa, Chức vụ, Số điện thoại, Email).
      </p>

      <div className="filter-bar">
        <button type="button" onClick={() => setShowImport((v) => !v)}>
          {showImport ? "Đóng nhập Excel" : "Nhập từ Excel"}
        </button>
        <button type="button" onClick={downloadSampleTemplate}>Tải file mẫu</button>
      </div>

      {showImport && (
        <div className="inline-form items-start flex-col">
          <input type="file" accept=".xlsx,.xls" onChange={handleFile} />

          {importRows.length > 0 && (
            <>
              <p className="hint mt-2">
                {validCount}/{importRows.length} dòng hợp lệ — {selectedCount} dòng sẽ được nhập.
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th><th>Dòng</th><th>Họ tên</th><th>Khoa</th><th>Chức vụ</th>
                    <th>SĐT</th><th>Email</th><th>Trạng thái</th>
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
                      <td>{r.fullName}</td>
                      <td>{r.facultyRaw}</td>
                      <td>{r.positionRaw}</td>
                      <td>{r.phone}</td>
                      <td>{r.email}</td>
                      <td>
                        {r.error
                          ? <span className="error-text mt-0">{r.error}</span>
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
              {importResult.errors.length > 0 && (
                <ul className="text-[13px] text-danger list-disc pl-5">
                  {importResult.errors.map((e) => (
                    <li key={e.index}>Dòng {e.index + 1}: {e.message}</li>
                  ))}
                </ul>
              )}
              <button type="button" onClick={closeImport}>Đóng</button>
            </div>
          )}
        </div>
      )}

      <form className="inline-form" onSubmit={handleSubmit}>
        <input placeholder="Họ và tên" value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
        <select value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
          <option value="">-- Chọn khoa --</option>
          {faculties.map((f) => <option key={f.FacultyId} value={f.FacultyId}>{f.FacultyName}</option>)}
        </select>
        <select value={form.positionId} onChange={(e) => setForm({ ...form, positionId: e.target.value })}>
          <option value="">-- Chọn chức vụ --</option>
          {positions.map((p) => <option key={p.PositionId} value={p.PositionId}>{p.PositionName}</option>)}
        </select>
        <input placeholder="Điện thoại" value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input placeholder="Email" value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <div>
          <input type="text" placeholder="Tìm môn theo tên..." value={subjectSearch} className="w-full mb-1"
            onChange={(e) => setSubjectSearch(e.target.value)} />
          <div className="subject-picker-list">
            {filteredSubjectGroups.length === 0 && <div className="hint">Không tìm thấy môn nào khớp.</div>}
            {filteredSubjectGroups.map((g) => {
              if (g.items.length === 1) {
                const s = g.items[0];
                return (
                  <label key={s.SubjectId} className="flex items-center gap-2">
                    <input type="checkbox" checked={form.subjectIds.includes(String(s.SubjectId))}
                      onChange={() => toggleSubject(s.SubjectId)} />
                    {subjectLabel(s)}{!s.IsActive ? " (Ngừng dùng)" : ""}
                  </label>
                );
              }
              const ids = g.items.map((s) => s.SubjectId);
              return (
                <div key={g.displayName}>
                  <label className="flex items-center gap-2 font-medium">
                    <SubjectGroupCheckbox ids={ids} subjectIds={form.subjectIds}
                      onToggle={(checkAll) => toggleSubjectGroup(ids, checkAll)} />
                    {g.displayName} ({g.items.length} ngành)
                  </label>
                  <div className="pl-5">
                    {g.items.map((s) => (
                      <label key={s.SubjectId} className="flex items-center gap-2">
                        <input type="checkbox" checked={form.subjectIds.includes(String(s.SubjectId))}
                          onChange={() => toggleSubject(s.SubjectId)} />
                        {subjectLabel(s)}{!s.IsActive ? " (Ngừng dùng)" : ""}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hint mt-1">Môn có thể dạy — tick checkbox "cha" để chọn nhanh mọi mã cùng tên (mọi ngành)</div>
        </div>
        <button type="submit">{editingId ? "Cập nhật" : "Thêm mới"}</button>
        {editingId && <button type="button" onClick={resetForm}>Hủy</button>}
      </form>
      {error && <div className="error-text">{error}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Họ tên</th><th>Khoa</th><th>Chức vụ</th><th>Điện thoại</th><th>Email</th><th>Môn dạy được</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.TeacherId}>
              <td>{idx + 1}</td>
              <td>{it.FullName}</td>
              <td>{it.FacultyName}</td>
              <td>{it.PositionName}</td>
              <td>{it.Phone}</td>
              <td>{it.Email}</td>
              <td>{it.Subjects}</td>
              <td>
                <button onClick={() => handleEdit(it)}>Sửa</button>
                <button onClick={() => handleDelete(it.TeacherId)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6">Giảng viên báo bận</h2>
      <p className="hint">Trong khoảng ngày báo bận, giảng viên sẽ không thể được xếp lịch dạy/coi thi.</p>
      <form className="inline-form" onSubmit={handleUnavailSubmit}>
        <select value={unavailForm.teacherId} onChange={(e) => setUnavailForm({ ...unavailForm, teacherId: e.target.value })} required>
          <option value="">-- Chọn giảng viên --</option>
          {items.map((t) => <option key={t.TeacherId} value={t.TeacherId}>{t.FullName}</option>)}
        </select>
        <input type="date" value={unavailForm.dateFrom}
          onChange={(e) => setUnavailForm({ ...unavailForm, dateFrom: e.target.value })} required />
        <input type="date" value={unavailForm.dateTo}
          onChange={(e) => setUnavailForm({ ...unavailForm, dateTo: e.target.value })} required />
        <input placeholder="Lý do (vd nghỉ phép, đi công tác...)" value={unavailForm.reason}
          onChange={(e) => setUnavailForm({ ...unavailForm, reason: e.target.value })} />
        <button type="submit">Báo bận</button>
      </form>
      {unavailError && <div className="error-text">{unavailError}</div>}

      <table className="data-table">
        <thead><tr><th>#</th><th>Giảng viên</th><th>Từ ngày</th><th>Đến ngày</th><th>Lý do</th><th></th></tr></thead>
        <tbody>
          {unavailItems.map((it, idx) => (
            <tr key={it.UnavailabilityId}>
              <td>{idx + 1}</td>
              <td>{it.FullName}</td>
              <td>{it.DateFrom?.slice(0, 10)}</td>
              <td>{it.DateTo?.slice(0, 10)}</td>
              <td>{it.Reason}</td>
              <td><button onClick={() => handleUnavailDelete(it.UnavailabilityId)}>Xóa</button></td>
            </tr>
          ))}
          {unavailItems.length === 0 && <tr><td colSpan={6}>Chưa có khai báo báo bận nào.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
