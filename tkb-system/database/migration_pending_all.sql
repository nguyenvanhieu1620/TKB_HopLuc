-- ================== PHẦN 1: Giờ học theo Khung chương trình ==================
USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'TotalHours')
BEGIN
    ALTER TABLE CurriculumItems ADD TotalHours INT NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'TheoryHours')
BEGIN
    ALTER TABLE CurriculumItems ADD TheoryHours INT NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'PracticeHours')
BEGIN
    ALTER TABLE CurriculumItems ADD PracticeHours INT NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'ExamHours')
BEGIN
    ALTER TABLE CurriculumItems ADD ExamHours INT NULL;
END
GO

-- ================== PHẦN 2: Hệ đào tạo, phân loại môn, tách nhóm, GV bận, nghỉ lễ, cấu hình ==================
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Majors') AND name = 'TrainingMode')
BEGIN
    ALTER TABLE Majors ADD TrainingMode NVARCHAR(10) NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Subjects') AND name = 'Category')
BEGIN
    ALTER TABLE Subjects ADD Category NVARCHAR(20) NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Schedule') AND name = 'GroupLabel')
BEGIN
    ALTER TABLE Schedule ADD GroupLabel NVARCHAR(30) NULL;
END
GO

IF OBJECT_ID('dbo.TeacherUnavailability', 'U') IS NULL
BEGIN
    CREATE TABLE TeacherUnavailability (
        UnavailabilityId INT IDENTITY(1,1) PRIMARY KEY,
        TeacherId        INT NOT NULL,
        DateFrom         DATE NOT NULL,
        DateTo           DATE NOT NULL,
        Reason           NVARCHAR(255) NULL,
        CreatedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT FK_TeacherUnavailability_Teacher FOREIGN KEY (TeacherId) REFERENCES Teachers(TeacherId),
        CONSTRAINT CK_TeacherUnavailability_Date CHECK (DateTo >= DateFrom)
    );
END
GO

IF OBJECT_ID('dbo.Holidays', 'U') IS NULL
BEGIN
    CREATE TABLE Holidays (
        HolidayId    INT IDENTITY(1,1) PRIMARY KEY,
        DateFrom     DATE NOT NULL,
        DateTo       DATE NOT NULL,
        Description  NVARCHAR(255) NOT NULL,
        CONSTRAINT CK_Holidays_Date CHECK (DateTo >= DateFrom)
    );
END
GO

IF OBJECT_ID('dbo.SchedulingPolicy', 'U') IS NULL
BEGIN
    CREATE TABLE SchedulingPolicy (
        PolicyKey    NVARCHAR(50) PRIMARY KEY,
        PolicyValue  NVARCHAR(50) NOT NULL,
        Description  NVARCHAR(255) NULL
    );
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES
    (N'MaxStudentsPerTheoryRoom',   N'35', N'Sĩ số tối đa 1 phòng lý thuyết'),
    (N'MaxStudentsPerPracticeGroup',N'10', N'Sĩ số tối đa 1 nhóm thực hành/ca'),
    (N'MaxStudentsPerClinicalGroup',N'15', N'Sĩ số tối đa 1 nhóm lâm sàng'),
    (N'TheoryPeriodMinutes',       N'45', N'Số phút 1 giờ lý thuyết'),
    (N'PracticePeriodMinutes',     N'60', N'Số phút 1 giờ thực hành/lâm sàng'),
    (N'MaxTheoryHoursPerSession',  N'5',  N'Số giờ LT tối đa 1 buổi'),
    (N'MaxPracticeHoursPerSession',N'4',  N'Số giờ TH tối đa 1 buổi'),
    (N'MaxTheoryHoursPerDay',      N'10', N'Số giờ LT tối đa 1 ngày/lớp'),
    (N'MaxPracticeHoursPerDay',    N'8',  N'Số giờ TH tối đa 1 ngày/lớp'),
    (N'MinWeeklyHoursCQ',          N'20', N'Số giờ tối thiểu/tuần hệ Chính quy'),
    (N'MaxWeeklyHoursCQ',          N'30', N'Số giờ tối đa/tuần hệ Chính quy'),
    (N'MinWeeklyHoursLT',          N'20', N'Số giờ tối thiểu/tuần hệ Liên thông'),
    (N'MaxWeeklyHoursLT',          N'30', N'Số giờ tối đa/tuần hệ Liên thông'),
    (N'MinWeeksPerSemester',       N'20', N'Số tuần tối thiểu/học kỳ'),
    (N'MaxWeeksPerSemester',       N'22', N'Số tuần tối đa/học kỳ'),
    (N'NotifyLeadDays',            N'5',  N'Số ngày báo trước khi ban hành TKB tuần mới');
END
GO

-- ================== PHẦN 3: Ca học (Sáng/Chiều/Tối) ==================
IF OBJECT_ID('dbo.Sessions', 'U') IS NULL
BEGIN
    CREATE TABLE Sessions (
        SessionId     INT IDENTITY(1,1) PRIMARY KEY,
        SessionName   NVARCHAR(20)    NOT NULL,
        StartTime     TIME(0)         NOT NULL,
        EndTime       TIME(0)         NOT NULL,
        SortOrder     INT             NOT NULL,
        IsActive      BIT             NOT NULL DEFAULT 1,
        CONSTRAINT UQ_Sessions_Name UNIQUE (SessionName),
        CONSTRAINT CK_Sessions_Time CHECK (EndTime > StartTime)
    );
    INSERT INTO Sessions (SessionName, StartTime, EndTime, SortOrder) VALUES
    (N'Sáng',  '07:00', '11:10', 1),
    (N'Chiều', '13:00', '17:10', 2),
    (N'Tối',   '18:00', '21:00', 3);
END
GO

-- ================== PHẦN 4: Ghép lớp ==================
IF OBJECT_ID('dbo.MergedSessions', 'U') IS NULL
BEGIN
    CREATE TABLE MergedSessions (
        MergedSessionId INT IDENTITY(1,1) PRIMARY KEY,
        Note            NVARCHAR(255) NULL,
        CreatedBy       INT NULL,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT FK_MergedSessions_User FOREIGN KEY (CreatedBy) REFERENCES Users(UserId)
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Schedule') AND name = 'MergedSessionId')
BEGIN
    ALTER TABLE Schedule ADD MergedSessionId INT NULL;
    ALTER TABLE Schedule ADD CONSTRAINT FK_Schedule_MergedSession FOREIGN KEY (MergedSessionId) REFERENCES MergedSessions(MergedSessionId);
END
GO

-- ================== PHẦN 5: Phòng sự cố, loại phòng mới, khung chương trình theo khóa ==================
IF OBJECT_ID('dbo.RoomUnavailability', 'U') IS NULL
BEGIN
    CREATE TABLE RoomUnavailability (
        UnavailabilityId INT IDENTITY(1,1) PRIMARY KEY,
        RoomId           INT NOT NULL,
        DateFrom         DATE NOT NULL,
        DateTo           DATE NOT NULL,
        Reason           NVARCHAR(255) NULL,
        CreatedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT FK_RoomUnavailability_Room FOREIGN KEY (RoomId) REFERENCES Rooms(RoomId),
        CONSTRAINT CK_RoomUnavailability_Date CHECK (DateTo >= DateFrom)
    );
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Rooms_Type')
BEGIN
    ALTER TABLE Rooms DROP CONSTRAINT CK_Rooms_Type;
END
GO
ALTER TABLE Rooms ADD CONSTRAINT CK_Rooms_Type
    CHECK (RoomType IN (N'LyThuyet', N'ThucHanh', N'Labo', N'LamSang', N'SanBai'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CurriculumItems') AND name = 'CohortId')
BEGIN
    ALTER TABLE CurriculumItems ADD CohortId INT NULL;
    ALTER TABLE CurriculumItems ADD CONSTRAINT FK_CurriculumItems_Cohort FOREIGN KEY (CohortId) REFERENCES Cohorts(CohortId);
END
GO

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_CurriculumItems' AND object_id = OBJECT_ID('dbo.CurriculumItems'))
BEGIN
    ALTER TABLE CurriculumItems DROP CONSTRAINT UQ_CurriculumItems;
END
GO
ALTER TABLE CurriculumItems ADD CONSTRAINT UQ_CurriculumItems UNIQUE (MajorId, SubjectId, CohortId);
GO

PRINT N'=== Hoàn tất toàn bộ migration còn thiếu ===';
