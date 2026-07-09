/* ============================================================
   MIGRATION: Khoa (Faculties) / Chức vụ / Khung chương trình đào tạo
   Áp dụng cho DB đã tạo từ schema.sql cũ (trước khi có Faculties/
   CurriculumItems) — đưa Teachers/Subjects về đúng cấu trúc mới.
   Giả định Teachers và Subjects hiện chưa có dữ liệu cần giữ lại;
   nếu đã có dữ liệu thật, cần backfill FacultyId/CurriculumItems
   từ Department/MajorId cũ trước khi DROP COLUMN.
   ============================================================ */

USE TKB_HopLuc;
GO

/* ---- Teachers: Department (text) -> FacultyId (FK) + Position ---- */
ALTER TABLE Teachers ADD FacultyId INT NULL;
GO
ALTER TABLE Teachers ADD CONSTRAINT FK_Teachers_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId);
GO
ALTER TABLE Teachers ADD Position NVARCHAR(100) NULL;
GO
ALTER TABLE Teachers DROP COLUMN Department;
GO

/* ---- Subjects: bỏ MajorId/TotalPeriods/SubjectType, thêm các trường mới ---- */
ALTER TABLE Subjects DROP CONSTRAINT FK_Subjects_Majors;
GO
ALTER TABLE Subjects DROP CONSTRAINT CK_Subjects_Type;
GO

-- TotalPeriods và SubjectType có DEFAULT constraint tự sinh tên ngẫu nhiên,
-- phải tìm và xóa trước khi DROP COLUMN.
DECLARE @dfName NVARCHAR(200);

SELECT @dfName = dc.name FROM sys.default_constraints dc
  JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('Subjects') AND c.name = 'TotalPeriods';
IF @dfName IS NOT NULL EXEC('ALTER TABLE Subjects DROP CONSTRAINT ' + @dfName);

SELECT @dfName = dc.name FROM sys.default_constraints dc
  JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('Subjects') AND c.name = 'SubjectType';
IF @dfName IS NOT NULL EXEC('ALTER TABLE Subjects DROP CONSTRAINT ' + @dfName);
GO

ALTER TABLE Subjects DROP COLUMN MajorId, TotalPeriods, SubjectType;
GO
ALTER TABLE Subjects ADD SubjectCode NVARCHAR(20) NULL;
GO
ALTER TABLE Subjects ADD FacultyId INT NULL;
GO
ALTER TABLE Subjects ADD CONSTRAINT FK_Subjects_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId);
GO
ALTER TABLE Subjects ADD Credits INT NULL;
GO
ALTER TABLE Subjects ADD TheoryHours INT NOT NULL DEFAULT 0;
GO
ALTER TABLE Subjects ADD PracticeHours INT NOT NULL DEFAULT 0;
GO
ALTER TABLE Subjects ADD ExamHours INT NOT NULL DEFAULT 0;
GO
