USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MaxTeachingHoursPerWeek')
BEGIN
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description)
    VALUES (N'MaxTeachingHoursPerWeek', N'25', N'Định mức giờ dạy chuẩn tối đa/tuần cho 1 GV (chặn cứng, tránh dồn quá tải 1 tuần cụ thể)');
END
GO

PRINT N'Đã thêm SchedulingPolicy.MaxTeachingHoursPerWeek.';
