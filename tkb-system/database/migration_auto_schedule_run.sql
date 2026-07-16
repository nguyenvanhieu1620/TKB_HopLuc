USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Schedule') AND name = 'AutoScheduleRunId')
BEGIN
    ALTER TABLE Schedule ADD AutoScheduleRunId UNIQUEIDENTIFIER NULL;
END
GO

PRINT N'Đã thêm Schedule.AutoScheduleRunId.';
