USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Schedule') AND name = 'GroupBatchId')
BEGIN
    ALTER TABLE Schedule ADD GroupBatchId INT NULL;
END
GO

PRINT N'Đã thêm Schedule.GroupBatchId.';
