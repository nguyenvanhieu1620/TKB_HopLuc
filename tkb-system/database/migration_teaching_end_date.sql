USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Semesters') AND name = 'TeachingEndDate')
BEGIN
    ALTER TABLE Semesters ADD TeachingEndDate DATE NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'ExamPeriodWeeks')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('ExamPeriodWeeks', '1', N'Số tuần cuối mỗi Kỳ dành riêng cho thi, không xếp tiết học thường');
GO

PRINT N'Đã thêm Semesters.TeachingEndDate và SchedulingPolicy.ExamPeriodWeeks.';
