USE TKB_HopLuc;
GO

-- Chuẩn hóa best-effort các biến thể text tự do đang có trong Subjects.Category về đúng 3 mã nội bộ.
-- Biến thể không nhận diện được sẽ set về NULL (không đoán bừa) — Admin tự rà soát lại sau.
UPDATE Subjects
SET Category = N'DaiCuong'
WHERE Category IS NOT NULL
  AND LOWER(LTRIM(RTRIM(Category))) IN (N'đại cương', N'dai cuong', N'daicuong');
GO

UPDATE Subjects
SET Category = N'CoSoNganh'
WHERE Category IS NOT NULL
  AND LOWER(LTRIM(RTRIM(Category))) IN (N'cơ sở ngành', N'co so nganh', N'cosonganh', N'cơ sở', N'co so');
GO

UPDATE Subjects
SET Category = N'ChuyenNganh'
WHERE Category IS NOT NULL
  AND LOWER(LTRIM(RTRIM(Category))) IN (N'chuyên ngành', N'chuyen nganh', N'chuyennganh');
GO

-- Mọi giá trị còn lại (không khớp 3 nhóm trên và chưa phải NULL/1 trong 3 mã chuẩn) coi là chưa nhận
-- diện được — set về NULL để không vi phạm CHECK constraint sắp thêm, và để Admin tự rà soát.
UPDATE Subjects
SET Category = NULL
WHERE Category IS NOT NULL
  AND Category NOT IN (N'DaiCuong', N'CoSoNganh', N'ChuyenNganh');
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Subjects_Category')
BEGIN
    ALTER TABLE Subjects ADD CONSTRAINT CK_Subjects_Category
      CHECK (Category IN (N'DaiCuong', N'CoSoNganh', N'ChuyenNganh') OR Category IS NULL);
END
GO

PRINT N'Đã chuẩn hóa Subjects.Category và thêm CK_Subjects_Category.';
