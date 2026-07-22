USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Exams') AND name = 'AutoScheduleRunId')
BEGIN
    ALTER TABLE Exams ADD AutoScheduleRunId UNIQUEIDENTIFIER NULL;
    PRINT N'Đã thêm cột Exams.AutoScheduleRunId.';
END
GO
