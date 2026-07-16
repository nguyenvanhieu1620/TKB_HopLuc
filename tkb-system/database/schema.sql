/* ============================================================
   HỆ THỐNG QUẢN LÝ THỜI KHÓA BIỂU - TRƯỜNG CAO ĐẲNG Y DƯỢC HỢP LỰC
   Script tạo cơ sở dữ liệu (SQL Server)
   ============================================================ */

IF DB_ID('TKB_HopLuc') IS NULL
BEGIN
    CREATE DATABASE TKB_HopLuc;
END
GO

USE TKB_HopLuc;
GO

/* ============================================================
   1. DANH MỤC: KHOA / BỘ MÔN
   ============================================================ */
CREATE TABLE Faculties (
    FacultyId     INT IDENTITY(1,1) PRIMARY KEY,
    FacultyName   NVARCHAR(150)   NOT NULL,
    IsActive      BIT             NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Faculties_Name UNIQUE (FacultyName)
);
GO

/* ============================================================
   1a. DANH MỤC: NGÀNH ĐÀO TẠO
   Mỗi ngành do 1 Khoa quản lý (FacultyId).
   ============================================================ */
CREATE TABLE Majors (
    MajorId       INT IDENTITY(1,1) PRIMARY KEY,
    MajorName     NVARCHAR(150)   NOT NULL,
    TrainingMode  NVARCHAR(10)    NULL,               -- hệ đào tạo: CQ (Chính quy) | LT (Liên thông)...
    FacultyId     INT             NULL,               -- khoa quản lý ngành (FK)
    IsActive      BIT             NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_Majors_Name UNIQUE (MajorName),
    CONSTRAINT FK_Majors_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId)
);
GO

/* ============================================================
   1b. DANH MỤC: KHÓA HỌC (COHORT) - vd K15, K16...
   ============================================================ */
CREATE TABLE Cohorts (
    CohortId      INT IDENTITY(1,1) PRIMARY KEY,
    CohortName    NVARCHAR(50)    NOT NULL,   -- vd 'K15'
    StartYear     INT             NOT NULL,   -- năm nhập học, vd 2023
    DurationYears INT             NOT NULL DEFAULT 3,  -- số năm đào tạo
    IsActive      BIT             NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Cohorts_Name UNIQUE (CohortName)
);
GO

/* ============================================================
   2. DANH MỤC: MÔN HỌC / MÔ-ĐUN
   Lưu ý (Việc AQ): mỗi Môn học gắn TRỰC TIẾP với 1 Ngành cụ thể qua
   MajorId — theo đúng quy ước mã hóa của trường (Thông báo
   390/TB-CĐYDHL), mỗi Ngành tự có mã riêng cho từng môn dù nội dung
   tương tự (vd "Toán cao cấp" mã D08 ở ngành Dược, mã Y08 ở ngành Y
   sỹ — 2 dòng Subjects riêng biệt, được phép TRÙNG TÊN). SubjectCode
   vì vậy BẮT BUỘC và phải DUY NHẤT toàn hệ thống (ràng buộc lọc theo
   SubjectCode IS NOT NULL để tương thích ngược với dữ liệu cũ chưa
   có mã). Bảng CurriculumItems (Khung chương trình đào tạo, phần 2a
   bên dưới) không đổi cấu trúc — vẫn giữ nguyên.
   ============================================================ */
CREATE TABLE Subjects (
    SubjectId     INT IDENTITY(1,1) PRIMARY KEY,
    SubjectCode   NVARCHAR(20)    NULL,               -- vd 'Y09', 'MH01' — bắt buộc + duy nhất (xem ràng buộc UQ_Subjects_SubjectCode)
    SubjectName   NVARCHAR(150)   NOT NULL,
    FacultyId     INT             NULL,               -- khoa phụ trách giảng dạy
    MajorId       INT             NULL,               -- ngành sở hữu môn này (Việc AQ)
    -- Phân loại môn theo khối kiến thức: DaiCuong | CoSoNganh | ChuyenNganh | NULL (chưa phân loại) —
    -- dùng để ưu tiên thứ tự xử lý môn khi tự động xếp lịch (Đại cương xếp trước, rồi Cơ sở ngành, rồi
    -- Chuyên ngành).
    Category      NVARCHAR(20)    NULL,
    Credits       INT             NULL,               -- số tín chỉ (giá trị chuẩn/mặc định)
    TheoryHours   INT             NOT NULL DEFAULT 0, -- giờ lý thuyết
    PracticeHours INT             NOT NULL DEFAULT 0, -- giờ thực hành
    ExamHours     INT             NOT NULL DEFAULT 0, -- giờ thi/kiểm tra
    IsActive      BIT             NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_Subjects_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId),
    CONSTRAINT FK_Subjects_Major FOREIGN KEY (MajorId) REFERENCES Majors(MajorId),
    CONSTRAINT CK_Subjects_Category CHECK (Category IN (N'DaiCuong', N'CoSoNganh', N'ChuyenNganh') OR Category IS NULL)
);
GO

CREATE UNIQUE INDEX UQ_Subjects_SubjectCode ON Subjects(SubjectCode) WHERE SubjectCode IS NOT NULL;
GO

/* ============================================================
   2a. KHUNG CHƯƠNG TRÌNH ĐÀO TẠO (Ngành <-> Môn học, nhiều-nhiều)
   Mỗi dòng: 1 môn học được dạy ở kỳ thứ mấy trong chương trình
   của 1 ngành cụ thể. Một Môn học có thể xuất hiện ở nhiều Ngành
   khác nhau (vd Tin học dùng chung cho mọi ngành). CohortId cho
   phép áp khung chương trình riêng theo từng khóa học (tùy chọn).
   ============================================================ */
CREATE TABLE CurriculumItems (
    CurriculumItemId INT IDENTITY(1,1) PRIMARY KEY,
    MajorId          INT NOT NULL,
    SubjectId        INT NOT NULL,
    CohortId         INT NULL,
    TermNumber       INT NOT NULL,          -- Kỳ thứ mấy trong chương trình (1,2,3...)
    Credits          INT NULL,              -- ghi đè số tín chỉ riêng cho ngành này nếu khác chuẩn ở Subjects
    TotalHours       INT NULL,
    TheoryHours      INT NULL,
    PracticeHours    INT NULL,
    ExamHours        INT NULL,
    -- Việc BA: hình thức dạy phần Thực hành của môn này — LyThuyet (dạy tại phòng Lý thuyết,
    -- 45p/tiết, nhưng vẫn tính vào chỉ tiêu giờ Thực hành), ThucHanh (mặc định, phòng Thực
    -- hành/Labo, 60p/tiết), LamSang (phòng Lâm sàng, 60p/tiết).
    PracticeMode     NVARCHAR(10) NOT NULL DEFAULT 'ThucHanh',
    SortOrder        INT NOT NULL DEFAULT 0,
    IsActive         BIT NOT NULL DEFAULT 1,
    CONSTRAINT FK_CurriculumItems_Major   FOREIGN KEY (MajorId)   REFERENCES Majors(MajorId),
    CONSTRAINT FK_CurriculumItems_Subject FOREIGN KEY (SubjectId) REFERENCES Subjects(SubjectId),
    CONSTRAINT FK_CurriculumItems_Cohort  FOREIGN KEY (CohortId)  REFERENCES Cohorts(CohortId),
    CONSTRAINT UQ_CurriculumItems UNIQUE (MajorId, SubjectId, CohortId),
    CONSTRAINT CK_CurriculumItems_PracticeMode CHECK (PracticeMode IN ('LyThuyet', 'ThucHanh', 'LamSang'))
);
GO

CREATE INDEX IX_CurriculumItems_Major ON CurriculumItems (MajorId, TermNumber);
GO

/* ============================================================
   3. DANH MỤC: LỚP HỌC
   ============================================================ */
CREATE TABLE Classes (
    ClassId       INT IDENTITY(1,1) PRIMARY KEY,
    ClassName     NVARCHAR(50)    NOT NULL,
    MajorId       INT             NOT NULL,
    CohortId      INT             NOT NULL,
    ClassSize     INT             NOT NULL DEFAULT 0,
    StartDate     DATE            NULL,   -- ngày khai giảng của lớp (trường tuyển sinh quanh năm, mỗi lớp 1 mốc riêng)
    -- Việc AZ: ghi đè KIỂU LỊCH HỌC (ngày/buổi) riêng cho lớp này, khác với Hệ đào tạo thật của
    -- Ngành (vd lớp văn bằng 2 thuộc Ngành hệ CQ nhưng học viên đi làm nên xếp lịch kiểu cuối
    -- tuần+tối như LT) — CHỈ ảnh hưởng kiểm tra ngày/buổi khi xếp lịch, KHÔNG ảnh hưởng chương
    -- trình/tín chỉ/số kỳ (những cái đó vẫn luôn theo đúng Majors.TrainingMode thật). NULL = dùng
    -- đúng Hệ của Ngành như bình thường (đa số lớp).
    SchedulePatternOverride NVARCHAR(10) NULL,
    IsActive      BIT             NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_Classes_Majors  FOREIGN KEY (MajorId)  REFERENCES Majors(MajorId),
    CONSTRAINT FK_Classes_Cohorts FOREIGN KEY (CohortId) REFERENCES Cohorts(CohortId),
    CONSTRAINT UQ_Classes_Name UNIQUE (ClassName),
    CONSTRAINT CK_Classes_SchedulePattern CHECK (SchedulePatternOverride IN ('CQ', 'LT') OR SchedulePatternOverride IS NULL)
);
GO

/* ============================================================
   4. DANH MỤC: PHÒNG HỌC
   ============================================================ */
CREATE TABLE Rooms (
    RoomId        INT IDENTITY(1,1) PRIMARY KEY,
    RoomName      NVARCHAR(50)    NOT NULL,
    RoomType      NVARCHAR(20)    NOT NULL DEFAULT N'LyThuyet',
    Capacity      INT             NULL,
    FacultyId     INT             NULL,   -- khoa quản lý (chỉ áp dụng cho phòng Thực hành/Lâm sàng; phòng lý thuyết dùng chung để trống)
    IsActive      BIT             NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Rooms_Name UNIQUE (RoomName),
    CONSTRAINT CK_Rooms_Type CHECK (RoomType IN (N'LyThuyet', N'ThucHanh', N'Labo', N'LamSang', N'SanBai')),
    CONSTRAINT FK_Rooms_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId)
);
GO

-- Khai báo khoảng thời gian phòng tạm khóa/sự cố, không thể xếp lịch vào
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
GO

/* ============================================================
   5. DANH MỤC: HỌC KỲ / ĐỢT HỌC
   ============================================================ */
-- Mỗi Lớp có bộ Kỳ học RIÊNG (trường tuyển sinh quanh năm, không dùng chung 1 danh mục Học kỳ
-- cho nhiều lớp như Rooms/Majors) — ClassId/TermNumber NULL-able để tương thích ngược với dữ
-- liệu Semesters cũ (nếu có) chưa gắn với lớp nào.
CREATE TABLE Semesters (
    SemesterId    INT IDENTITY(1,1) PRIMARY KEY,
    SemesterName  NVARCHAR(100)   NOT NULL,
    AcademicYear  NVARCHAR(20)    NOT NULL,   -- năm học, vd '2025-2026'
    StartDate     DATE            NOT NULL,
    EndDate       DATE            NOT NULL,
    -- Việc BG: hạn cuối xếp tiết học thường — sau ngày này (nếu khác NULL) dành riêng cho thi cuối
    -- kỳ. Kỳ tự sinh (generate-terms) tự tính = EndDate trừ ExamPeriodWeeks tuần; Kỳ thêm thủ công
    -- mặc định NULL (không bắt buộc).
    TeachingEndDate DATE          NULL,
    ClassId       INT             NULL,
    TermNumber    INT             NULL,       -- Kỳ thứ mấy của lớp (1, 2, 3...)
    IsActive      BIT             NOT NULL DEFAULT 1,
    CONSTRAINT CK_Semesters_Date CHECK (EndDate >= StartDate),
    CONSTRAINT FK_Semesters_Class FOREIGN KEY (ClassId) REFERENCES Classes(ClassId)
);
GO

CREATE INDEX IX_Semesters_Class ON Semesters (ClassId);
GO

/* ============================================================
   5c. DANH MỤC: CHỨC VỤ GIẢNG VIÊN
   ============================================================ */
CREATE TABLE Positions (
    PositionId    INT IDENTITY(1,1) PRIMARY KEY,
    PositionName  NVARCHAR(100)   NOT NULL,
    IsActive      BIT             NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Positions_Name UNIQUE (PositionName)
);
GO

INSERT INTO Positions (PositionName) VALUES
(N'Trưởng khoa'), (N'Phó trưởng khoa'), (N'Giảng viên'), (N'Giáo vụ');
GO

/* ============================================================
   6. DANH MỤC: GIẢNG VIÊN
   ============================================================ */
CREATE TABLE Teachers (
    TeacherId     INT IDENTITY(1,1) PRIMARY KEY,
    FullName      NVARCHAR(100)   NOT NULL,
    FacultyId     INT             NULL,       -- khoa/bộ môn công tác (FK)
    PositionId    INT             NULL,       -- chức vụ (FK -> Positions)
    Phone         NVARCHAR(20)    NULL,
    Email         NVARCHAR(100)   NULL,
    IsActive      BIT             NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_Teachers_Faculty  FOREIGN KEY (FacultyId)  REFERENCES Faculties(FacultyId),
    CONSTRAINT FK_Teachers_Position FOREIGN KEY (PositionId) REFERENCES Positions(PositionId)
);
GO

-- Môn học mà từng giảng viên có thể đảm nhiệm (n-n)
CREATE TABLE TeacherSubjects (
    TeacherId     INT NOT NULL,
    SubjectId     INT NOT NULL,
    PRIMARY KEY (TeacherId, SubjectId),
    CONSTRAINT FK_TeacherSubjects_Teacher FOREIGN KEY (TeacherId) REFERENCES Teachers(TeacherId),
    CONSTRAINT FK_TeacherSubjects_Subject FOREIGN KEY (SubjectId) REFERENCES Subjects(SubjectId)
);
GO

-- Khai báo khoảng thời gian giảng viên bận/nghỉ, không thể xếp lịch dạy
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
GO

/* ============================================================
   6a. DANH MỤC: CA HỌC TRONG NGÀY (Sáng / Chiều / Tối)
   Xếp lịch theo ca thay vì theo tiết.
   ============================================================ */
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
GO

INSERT INTO Sessions (SessionName, StartTime, EndTime, SortOrder) VALUES
(N'Sáng',  '07:00', '11:10', 1),
(N'Chiều', '13:00', '17:10', 2),
(N'Tối',   '18:00', '21:00', 3);
GO

/* ============================================================
   6b. DANH MỤC: NGÀY NGHỈ LỄ
   ============================================================ */
CREATE TABLE Holidays (
    HolidayId    INT IDENTITY(1,1) PRIMARY KEY,
    DateFrom     DATE NOT NULL,
    DateTo       DATE NOT NULL,
    Description  NVARCHAR(255) NOT NULL,
    AppliesTo    NVARCHAR(10) NOT NULL DEFAULT N'ALL',  -- CQ | LT | ALL — hệ Liên thông không nghỉ hè nên có thể khác hệ Chính quy
    CONSTRAINT CK_Holidays_Date CHECK (DateTo >= DateFrom),
    CONSTRAINT CK_Holidays_AppliesTo CHECK (AppliesTo IN (N'CQ', N'LT', N'ALL'))
);
GO

/* ============================================================
   6c. CẤU HÌNH QUY TẮC XẾP LỊCH (SI SỐ, SỐ GIỜ, THÔNG BÁO...)
   ============================================================ */
CREATE TABLE SchedulingPolicy (
    PolicyKey    NVARCHAR(50) PRIMARY KEY,
    PolicyValue  NVARCHAR(50) NOT NULL,
    Description  NVARCHAR(255) NULL
);
GO

INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES
(N'MaxStudentsPerTheoryRoom',   N'35', N'Sĩ số tối đa 1 phòng lý thuyết'),
(N'MaxStudentsPerPracticeGroup',N'10', N'Sĩ số tối đa 1 nhóm thực hành/ca'),
(N'MaxStudentsPerClinicalGroup',N'15', N'Sĩ số tối đa 1 nhóm lâm sàng'),
(N'TheoryPeriodMinutes',       N'45', N'Số phút 1 giờ lý thuyết'),
(N'PracticePeriodMinutes',     N'60', N'Số phút 1 giờ thực hành/lâm sàng'),
(N'MaxTheoryHoursPerSession',  N'5',  N'Số tiết LT tối đa 1 buổi'),
(N'MaxPracticeHoursPerSession',N'4',  N'Số tiết TH tối đa 1 buổi'),
(N'MaxTheoryHoursPerDay',      N'10', N'Số tiết LT tối đa 1 ngày/lớp'),
(N'MaxPracticeHoursPerDay',    N'8',  N'Số tiết TH tối đa 1 ngày/lớp'),
(N'MinWeeklyHoursCQ',          N'20', N'Số giờ tối thiểu/tuần hệ Chính quy'),
(N'MaxWeeklyHoursCQ',          N'30', N'Số giờ tối đa/tuần hệ Chính quy'),
(N'MinWeeklyHoursLT',          N'20', N'Số giờ tối thiểu/tuần hệ Liên thông'),
(N'MaxWeeklyHoursLT',          N'30', N'Số giờ tối đa/tuần hệ Liên thông'),
(N'MinWeeksPerSemesterCQ',     N'20', N'Số tuần tối thiểu/học kỳ hệ Chính quy'),
(N'MaxWeeksPerSemesterCQ',     N'22', N'Số tuần tối đa/học kỳ hệ Chính quy'),
(N'MinWeeksPerSemesterLT',     N'19', N'Số tuần tối thiểu/học kỳ hệ Liên thông'),
(N'MaxWeeksPerSemesterLT',     N'20', N'Số tuần tối đa/học kỳ hệ Liên thông'),
(N'ProgramDurationMonthsCQ',   N'36', N'Tổng thời gian đào tạo hệ Chính quy (tháng)'),
(N'ProgramDurationMonthsLT',   N'18', N'Tổng thời gian đào tạo hệ Liên thông (tháng)'),
(N'TotalTermsCQ',              N'6',  N'Tổng số kỳ học cả chương trình hệ Chính quy'),
(N'TotalTermsLT',              N'4',  N'Tổng số kỳ học cả chương trình hệ Liên thông'),
(N'MinProctorsPerExam',        N'2',  N'Số giám thị tối thiểu cho mỗi phòng thi'),
(N'NotifyLeadDays',            N'5',  N'Số ngày báo trước khi ban hành TKB tuần mới'),
(N'MaxTeachingHoursPerYearManager', N'300', N'Định mức giờ dạy/năm cho GV kiêm quản lý (Trưởng/Phó khoa)'),
(N'MaxTeachingHoursPerYearStandard',N'450', N'Định mức giờ dạy/năm cho GV thường'),
(N'MaxTeachingHoursPerWeek',        N'25',  N'Định mức giờ dạy chuẩn tối đa/tuần cho 1 GV (chặn cứng, tránh dồn quá tải 1 tuần cụ thể)'),
(N'ExamPeriodWeeks',                N'1',   N'Số tuần cuối mỗi Kỳ dành riêng cho thi, không xếp tiết học thường');
GO

/* ============================================================
   7. TÀI KHOẢN NGƯỜI DÙNG
   ============================================================ */
CREATE TABLE Users (
    UserId        INT IDENTITY(1,1) PRIMARY KEY,
    Username      NVARCHAR(50)    NOT NULL,
    PasswordHash  NVARCHAR(255)   NOT NULL,
    Role          NVARCHAR(20)    NOT NULL DEFAULT N'Teacher',   -- Admin | Teacher
    TeacherId     INT             NULL,        -- gắn với hồ sơ GV nếu Role = Teacher
    IsActive      BIT             NOT NULL DEFAULT 1,
    LastLoginAt   DATETIME2       NULL,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_Users_Username UNIQUE (Username),
    CONSTRAINT FK_Users_Teacher FOREIGN KEY (TeacherId) REFERENCES Teachers(TeacherId),
    CONSTRAINT CK_Users_Role CHECK (Role IN (N'Admin', N'Teacher'))
);
GO

/* ============================================================
   7a. GHÉP LỚP (nhiều lớp học chung 1 buổi/môn/phòng/GV)
   ============================================================ */
CREATE TABLE MergedSessions (
    MergedSessionId INT IDENTITY(1,1) PRIMARY KEY,
    Note            NVARCHAR(255) NULL,
    CreatedBy       INT NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_MergedSessions_User FOREIGN KEY (CreatedBy) REFERENCES Users(UserId)
);
GO

/* ============================================================
   8. THỜI KHÓA BIỂU (LỊCH HỌC)
   ============================================================ */
CREATE TABLE Schedule (
    ScheduleId       INT IDENTITY(1,1) PRIMARY KEY,
    SemesterId       INT             NOT NULL,
    ClassId          INT             NOT NULL,
    SubjectId        INT             NOT NULL,
    RoomId           INT             NOT NULL,
    ScheduleDate     DATE            NOT NULL,
    StartTime        TIME(0)         NOT NULL,
    EndTime          TIME(0)         NOT NULL,
    GroupLabel       NVARCHAR(30)    NULL,   -- nhãn nhóm tách lớp (vd 'Nhóm 1', 'Tổ TH-A')
    MergedSessionId  INT             NULL,   -- khác NULL nếu buổi học này thuộc 1 lần ghép lớp
    -- Việc BA: 'Theory'/'Practice' — đánh dấu tường minh buổi này tính vào chỉ tiêu Lý thuyết hay
    -- Thực hành của môn, vì PracticeMode=LyThuyet khiến 1 buổi Thực hành vẫn dùng phòng Lý thuyết
    -- (RoomType không còn đủ để suy luận đúng). NULL = dữ liệu cũ, fallback suy theo RoomType.
    SessionType      NVARCHAR(10)    NULL,
    -- Việc BB: đánh dấu các dòng Schedule cùng thuộc 1 lần Tách nhóm (groupedCreate) — mang chung
    -- giá trị = ScheduleId của nhóm đầu tiên trong lô. Dùng để tính TIẾN ĐỘ môn học không đếm trùng
    -- (các nhóm học song song/xoay vòng chỉ là 1 buổi thực chất, không phải nhiều buổi lặp lại).
    GroupBatchId     INT             NULL,
    -- Đánh dấu mọi dòng do 1 lần chạy thuật toán tự động xếp lịch tạo ra — dùng để xem lại/hủy toàn
    -- bộ 1 lần chạy cụ thể mà không ảnh hưởng dữ liệu xếp tay hoặc các lần chạy khác.
    AutoScheduleRunId UNIQUEIDENTIFIER NULL,
    Note             NVARCHAR(500)   NULL,
    CreatedBy        INT             NULL,
    CreatedAt        DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    UpdatedAt        DATETIME2       NULL,
    CONSTRAINT FK_Schedule_Semester FOREIGN KEY (SemesterId) REFERENCES Semesters(SemesterId),
    CONSTRAINT FK_Schedule_Class    FOREIGN KEY (ClassId)    REFERENCES Classes(ClassId),
    CONSTRAINT FK_Schedule_Subject  FOREIGN KEY (SubjectId)  REFERENCES Subjects(SubjectId),
    CONSTRAINT FK_Schedule_Room     FOREIGN KEY (RoomId)     REFERENCES Rooms(RoomId),
    CONSTRAINT FK_Schedule_User     FOREIGN KEY (CreatedBy)  REFERENCES Users(UserId),
    CONSTRAINT FK_Schedule_MergedSession FOREIGN KEY (MergedSessionId) REFERENCES MergedSessions(MergedSessionId),
    CONSTRAINT CK_Schedule_Time CHECK (EndTime > StartTime)
);
GO

-- 1 tiết học có thể do nhiều giảng viên phụ trách (n-n)
CREATE TABLE ScheduleTeachers (
    ScheduleId    INT NOT NULL,
    TeacherId     INT NOT NULL,
    PRIMARY KEY (ScheduleId, TeacherId),
    CONSTRAINT FK_SchTeachers_Schedule FOREIGN KEY (ScheduleId) REFERENCES Schedule(ScheduleId) ON DELETE CASCADE,
    CONSTRAINT FK_SchTeachers_Teacher  FOREIGN KEY (TeacherId)  REFERENCES Teachers(TeacherId)
);
GO

-- Index phục vụ truy vấn / kiểm tra xung đột lịch học
CREATE INDEX IX_Schedule_Room_Date   ON Schedule (RoomId, ScheduleDate, StartTime, EndTime);
CREATE INDEX IX_Schedule_Class_Date  ON Schedule (ClassId, ScheduleDate);
CREATE INDEX IX_SchTeachers_Teacher  ON ScheduleTeachers (TeacherId);
GO

/* ============================================================
   9. LỊCH THI KẾT THÚC MÔN HỌC
   ============================================================ */
CREATE TABLE Exams (
    ExamId        INT IDENTITY(1,1) PRIMARY KEY,
    SemesterId    INT             NOT NULL,
    ClassId       INT             NOT NULL,
    SubjectId     INT             NOT NULL,
    RoomId        INT             NOT NULL,
    ExamDate      DATE            NOT NULL,
    StartTime     TIME(0)         NOT NULL,
    EndTime       TIME(0)         NOT NULL,
    ExamType      NVARCHAR(20)    NOT NULL DEFAULT N'TuLuan',   -- TuLuan|TracNghiem|VanDap|ThucHanh
    Status        NVARCHAR(20)    NOT NULL DEFAULT N'ChuaThi',  -- ChuaThi|DaThi|Huy
    Note          NVARCHAR(500)   NULL,
    CreatedBy     INT             NULL,
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    UpdatedAt     DATETIME2       NULL,
    CONSTRAINT FK_Exams_Semester FOREIGN KEY (SemesterId) REFERENCES Semesters(SemesterId),
    CONSTRAINT FK_Exams_Class    FOREIGN KEY (ClassId)    REFERENCES Classes(ClassId),
    CONSTRAINT FK_Exams_Subject  FOREIGN KEY (SubjectId)  REFERENCES Subjects(SubjectId),
    CONSTRAINT FK_Exams_Room     FOREIGN KEY (RoomId)     REFERENCES Rooms(RoomId),
    CONSTRAINT FK_Exams_User     FOREIGN KEY (CreatedBy)  REFERENCES Users(UserId),
    CONSTRAINT CK_Exams_Time CHECK (EndTime > StartTime),
    CONSTRAINT CK_Exams_Type CHECK (ExamType IN (N'TuLuan', N'TracNghiem', N'VanDap', N'ThucHanh')),
    CONSTRAINT CK_Exams_Status CHECK (Status IN (N'ChuaThi', N'DaThi', N'Huy'))
);
GO

-- Giám thị coi thi cho từng ca thi (n-n, thường 1-2 người/ca)
CREATE TABLE ExamProctors (
    ExamId        INT NOT NULL,
    TeacherId     INT NOT NULL,
    PRIMARY KEY (ExamId, TeacherId),
    CONSTRAINT FK_ExamProctors_Exam    FOREIGN KEY (ExamId)    REFERENCES Exams(ExamId) ON DELETE CASCADE,
    CONSTRAINT FK_ExamProctors_Teacher FOREIGN KEY (TeacherId) REFERENCES Teachers(TeacherId)
);
GO

-- Index phục vụ truy vấn / kiểm tra xung đột lịch thi
CREATE INDEX IX_Exams_Room_Date    ON Exams (RoomId, ExamDate, StartTime, EndTime);
CREATE INDEX IX_Exams_Class_Date   ON Exams (ClassId, ExamDate);
CREATE INDEX IX_ExamProctors_Teacher ON ExamProctors (TeacherId);
GO

/* ============================================================
   10. THÔNG BÁO
   ============================================================ */
CREATE TABLE Notifications (
    NotificationId INT IDENTITY(1,1) PRIMARY KEY,
    UserId         INT             NOT NULL,         -- người nhận
    Content        NVARCHAR(500)   NOT NULL,
    RelatedType    NVARCHAR(20)    NULL,              -- Schedule | Exam
    RelatedId      INT             NULL,
    IsRead         BIT             NOT NULL DEFAULT 0,
    CreatedAt      DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_Notifications_User FOREIGN KEY (UserId) REFERENCES Users(UserId)
);
GO

CREATE INDEX IX_Notifications_User ON Notifications (UserId, IsRead);
GO

/* ============================================================
   11. NHẬT KÝ THAO TÁC (AUDIT LOG)
   ============================================================ */
CREATE TABLE AuditLog (
    LogId         INT IDENTITY(1,1) PRIMARY KEY,
    UserId        INT             NULL,
    Action        NVARCHAR(20)    NOT NULL,     -- Insert | Update | Delete
    TableName     NVARCHAR(50)    NOT NULL,
    RecordId      INT             NULL,
    Detail        NVARCHAR(MAX)   NULL,         -- lưu JSON dữ liệu trước/sau khi đổi
    CreatedAt     DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT FK_AuditLog_User FOREIGN KEY (UserId) REFERENCES Users(UserId)
);
GO

CREATE INDEX IX_AuditLog_Table_Record ON AuditLog (TableName, RecordId);
GO

/* ============================================================
   12. TÀI KHOẢN ADMIN MẶC ĐỊNH (đổi mật khẩu ngay sau khi cài đặt)
   PasswordHash bên dưới chỉ là placeholder, backend cần hash thật
   (bcrypt) khi khởi tạo tài khoản, KHÔNG lưu mật khẩu dạng thô.
   ============================================================ */
INSERT INTO Users (Username, PasswordHash, Role, IsActive)
VALUES (N'admin', N'__REPLACE_WITH_BCRYPT_HASH__', N'Admin', 1);
GO
