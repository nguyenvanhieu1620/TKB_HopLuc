USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Classes') AND name = 'SchedulePatternOverride')
BEGIN
    ALTER TABLE Classes ADD SchedulePatternOverride NVARCHAR(10) NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Classes_SchedulePattern')
BEGIN
    ALTER TABLE Classes ADD CONSTRAINT CK_Classes_SchedulePattern CHECK (SchedulePatternOverride IN ('CQ', 'LT') OR SchedulePatternOverride IS NULL);
END
GO

PRINT N'Đã thêm Classes.SchedulePatternOverride.';
