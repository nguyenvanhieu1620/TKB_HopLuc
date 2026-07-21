USE TKB_HopLuc;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_CurriculumItems_PracticeMode')
BEGIN
    ALTER TABLE CurriculumItems DROP CONSTRAINT CK_CurriculumItems_PracticeMode;
END
GO
ALTER TABLE CurriculumItems ADD CONSTRAINT CK_CurriculumItems_PracticeMode
    CHECK (PracticeMode IN ('LyThuyet', 'ThucHanh', 'LamSang', 'SanBai'));
GO

PRINT N'Đã thêm giá trị SanBai vào PracticeMode.';
