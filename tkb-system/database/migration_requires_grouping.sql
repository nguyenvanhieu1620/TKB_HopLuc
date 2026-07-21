USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Subjects') AND name = 'RequiresGrouping')
BEGIN
    ALTER TABLE Subjects ADD RequiresGrouping BIT NOT NULL DEFAULT 1;
    PRINT N'Đã thêm cột Subjects.RequiresGrouping.';
END
GO
