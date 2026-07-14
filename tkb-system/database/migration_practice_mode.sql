USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'PracticeMode')
BEGIN
    ALTER TABLE CurriculumItems ADD PracticeMode NVARCHAR(10) NOT NULL DEFAULT 'ThucHanh';
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_CurriculumItems_PracticeMode')
BEGIN
    ALTER TABLE CurriculumItems ADD CONSTRAINT CK_CurriculumItems_PracticeMode CHECK (PracticeMode IN ('LyThuyet', 'ThucHanh', 'LamSang'));
END
GO

PRINT N'Đã thêm CurriculumItems.PracticeMode.';

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Schedule') AND name = 'SessionType')
BEGIN
    ALTER TABLE Schedule ADD SessionType NVARCHAR(10) NULL;
END
GO

PRINT N'Đã thêm Schedule.SessionType.';
